require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const sql = require('mssql');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 8080;

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL  = process.env.GOOGLE_CALLBACK_URL || 'https://hd.hilitravel.com/auth/google/callback';

let pool;
const sqlConfig = {
  server:   process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DATABASE,
  authentication: {
    type: 'default',
    options: {
      userName: process.env.AZURE_SQL_USER,
      password: process.env.AZURE_SQL_PASSWORD,
    }
  },
  options: {
    encrypt: true,
    trustServerCertificate: false,
    connectionTimeout: 30000,
    requestTimeout: 30000,
  }
};

const dbQuery = async (sql, params = []) => {
  try {
    const request = pool.request();
    let paramIndex = 0;
    sql = sql.replace(/\?/g, () => `@param${paramIndex++}`);
    for (let i = 0; i < params.length; i++) {
      request.input(`param${i}`, params[i]);
    }
    const result = await request.query(sql);
    return result.recordset || [];
  } catch(e) { 
    console.error('[DB Query]', e.message); 
    throw e;
  }
};

const dbQueryOne = async (sql, params = []) => {
  const rows = await dbQuery(sql, params);
  return rows[0] || null;
};

const dbRun = async (sql, params = []) => {
  try {
    const request = pool.request();
    let paramIndex = 0;
    sql = sql.replace(/\?/g, () => `@param${paramIndex++}`);
    for (let i = 0; i < params.length; i++) {
      request.input(`param${i}`, params[i]);
    }
    const result = await request.query(sql);
    if (result.recordset && result.recordset[0]) {
      return result.recordset[0][''] || null;
    }
    return null;
  } catch(e) {
    console.error('[DB Run]', e.message);
    throw e;
  }
};

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadToCloudinary = (buffer, filename, mimetype) => {
  return new Promise((resolve, reject) => {
    const folder = 'helpdesk';
    const resourceType = mimetype && mimetype.startsWith('video') ? 'video' : 'auto';
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, public_id: filename.replace(/\.[^/.]+$/, ''), resource_type: resourceType },
      (err, result) => err ? reject(err) : resolve(result)
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const useCloudinary = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY);

const storage = useCloudinary
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadsDir),
      filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
        const ext = path.extname(file.originalname);
        cb(null, unique + ext);
      }
    });

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf','.doc','.docx','.xls','.xlsx','.png','.jpg','.jpeg','.gif','.zip','.txt','.csv','.mp4','.mov','.webm','.m4v','.avi','.mkv'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

async function initDB() {
  console.log('[DB] Connessione ad Azure SQL Database in corso...');
  pool = new sql.ConnectionPool(sqlConfig);
  
  try {
    await pool.connect();
    console.log('✓ Connesso ad Azure SQL Database');
    console.log('✓ Database pronto');
  } catch(err) {
    console.error('[DB] Errore inizializzazione:', err.message);
    throw err;
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'helpdesk-secret-cambiami-in-produzione',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
  clientID:     GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL:  GOOGLE_CALLBACK_URL,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value.toLowerCase();
    const user = await dbQueryOne('SELECT * FROM [users] WHERE email=? AND attivo=1', [email]);
    if (!user) return done(null, false, { message: 'Utente non trovato' });
    return done(null, user);
  } catch(e) { return done(e); }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await dbQueryOne('SELECT * FROM [users] WHERE id=?', [id]);
    done(null, user || false);
  } catch(e) { done(e); }
});

const auth  = (req,res,next) => req.session.userId ? next() : res.status(401).json({error:'Non autenticato'});
const admin = async (req,res,next) => {
  if (!req.session.userId) return res.status(401).json({error:'Non autenticato'});
  const u = await dbQueryOne('SELECT ruolo FROM [users] WHERE id=?',[req.session.userId]);
  if (!u || u.ruolo !== 'admin') return res.status(403).json({error:'Accesso negato'});
  next();
};

app.post('/api/login', async (req,res) => {
  const {email,password}=req.body;
  if(!email||!password) return res.status(400).json({error:'Campi mancanti'});
  const user = await dbQueryOne('SELECT * FROM [users] WHERE email=? AND attivo=1',[email.toLowerCase().trim()]);
  if(!user||!bcrypt.compareSync(password,user.password)) return res.status(401).json({error:'Email o password non corretti'});
  req.session.userId=user.id;
  res.json({id:user.id,nome:user.nome,cognome:user.cognome,email:user.email,ruolo:user.ruolo,area:user.area});
});

app.post('/api/logout',(req,res)=>{req.session.destroy();res.json({ok:true});});

app.get('/api/me', auth, async (req,res) => {
  res.json(await dbQueryOne('SELECT id,nome,cognome,email,ruolo,area FROM [users] WHERE id=?',[req.session.userId]));
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=google_auth', session: false }),
  (req, res) => {
    req.session.userId = req.user.id;
    res.redirect('/');
  }
);

app.get('/api/tickets', auth, async (req,res) => {
  const {area,stato,priorita,q,assegnato_a,aperto_da,fonte}=req.query;
  let sql=`SELECT t.*,c.tipo as cat_tipo,c.nome as cat_nome,
    u1.nome + ' ' + u1.cognome as aperto_da_nome,
    u2.nome + ' ' + u2.cognome as assegnato_a_nome,
    (SELECT COUNT(*) FROM [allegati] a WHERE a.ticket_id=t.id) as n_allegati
    FROM [ticket] t
    LEFT JOIN [categorie] c ON t.categoria_id=c.id
    LEFT JOIN [users] u1 ON t.aperto_da=u1.id
    LEFT JOIN [users] u2 ON t.assegnato_a=u2.id WHERE 1=1`;
  const p=[];
  const me = await dbQueryOne('SELECT ruolo FROM [users] WHERE id=?',[req.session.userId]);
  if (me && me.ruolo === 'dipendente') {
    sql+=' AND t.aperto_da=?'; p.push(req.session.userId);
    if(stato){sql+=' AND t.stato=?';p.push(stato);}
    if(q){sql+=' AND (t.titolo LIKE ? OR t.codice LIKE ? OR t.descrizione LIKE ?)';const s='%'+q+'%';p.push(s,s,s);}
  } else {
    if(area){sql+=' AND t.area=?';p.push(area);}
    if(stato){sql+=' AND t.stato=?';p.push(stato);}
    if(priorita){sql+=' AND t.priorita=?';p.push(priorita);}
    if(fonte){sql+=' AND t.fonte=?';p.push(fonte);}
    if(assegnato_a){sql+=' AND t.assegnato_a=?';p.push(parseInt(assegnato_a,10));}
    if(aperto_da){sql+=' AND t.aperto_da=?';p.push(parseInt(aperto_da,10));}
    if(q){sql+=' AND (t.titolo LIKE ? OR t.codice LIKE ? OR t.descrizione LIKE ?)';const s='%'+q+'%';p.push(s,s,s);}
  }
  sql+=` ORDER BY CASE t.priorita WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, t.creato_il DESC`;
  res.json(await dbQuery(sql,p));
});

app.get('/api/aree', auth, async (req,res) => {
  res.json(await dbQuery('SELECT * FROM [aree] WHERE attivo=1 ORDER BY ordine,nome'));
});

app.get('/api/categorie', auth, async (req,res) => res.json(await dbQuery('SELECT * FROM [categorie] WHERE attivo=1 ORDER BY tipo,nome')));

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

initDB().then(()=>{
  app.listen(PORT,()=>console.log(`\n🚀 Help Desk → http://localhost:${PORT}\n   Admin: agiampa@hilitravel.com / admin123\n`));
}).catch(err=>{console.error('Errore DB:',err);process.exit(1);});
