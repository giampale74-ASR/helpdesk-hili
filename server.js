require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Google OAuth config ───────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL  = process.env.GOOGLE_CALLBACK_URL || 'https://hd.hilitravel.com/auth/google/callback';

// ── Upload config ─────────────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
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
    const allowed = ['.pdf','.doc','.docx','.xls','.xlsx','.png','.jpg','.jpeg','.gif','.zip','.txt','.csv','.mp4','.mov'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// ── Database Turso ────────────────────────────────────────────────────────────
let db;

const dbQuery = async (sql, params = []) => {
  const result = await db.execute({ sql, args: params });
  return result.rows.map(row => {
    const obj = {};
    result.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
};
const dbQueryOne = async (sql, params = []) => {
  const rows = await dbQuery(sql, params);
  return rows[0] || null;
};
const dbRun = async (sql, params = []) => {
  const result = await db.execute({ sql, args: params });
  return Number(result.lastInsertRowid) || null;
};

async function initDB() {
  db = createClient({
    url:       process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  // ── Schema ────────────────────────────────────────────────────────────────────
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      nome      TEXT NOT NULL,
      cognome   TEXT NOT NULL,
      email     TEXT NOT NULL UNIQUE,
      password  TEXT NOT NULL,
      ruolo     TEXT NOT NULL DEFAULT 'operatore',
      area      TEXT,
      attivo    INTEGER NOT NULL DEFAULT 1,
      creato_il TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS categorie (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo   TEXT NOT NULL,
      nome   TEXT NOT NULL,
      attivo INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS ticket (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      codice        TEXT NOT NULL UNIQUE,
      titolo        TEXT NOT NULL,
      descrizione   TEXT,
      area          TEXT NOT NULL,
      fonte         TEXT NOT NULL,
      categoria_id  INTEGER,
      priorita      TEXT NOT NULL DEFAULT 'media',
      stato         TEXT NOT NULL DEFAULT 'nuovo',
      aperto_da     INTEGER,
      assegnato_a   INTEGER,
      creato_il     TEXT NOT NULL DEFAULT (datetime('now')),
      aggiornato_il TEXT NOT NULL DEFAULT (datetime('now')),
      risolto_il    TEXT
    );
    CREATE TABLE IF NOT EXISTS attivita (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      utente_id INTEGER,
      tipo      TEXT NOT NULL,
      testo     TEXT NOT NULL,
      creato_il TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS allegati (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id    INTEGER NOT NULL,
      utente_id    INTEGER,
      filename     TEXT NOT NULL,
      originalname TEXT NOT NULL,
      size         INTEGER NOT NULL,
      mimetype     TEXT,
      creato_il    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ── Seed demo ─────────────────────────────────────────────────────────────────
  const cnt = await dbQueryOne('SELECT COUNT(*) as c FROM users');
  if (!cnt || cnt.c === 0) {
    const hA = bcrypt.hashSync('admin123', 10);
    const hO = bcrypt.hashSync('operatore123', 10);
    const u = (n,c,e,p,r,a) => dbRun('INSERT INTO users (nome,cognome,email,password,ruolo,area) VALUES (?,?,?,?,?,?)',[n,c,e,p,r,a]);
    await u('Admin','Sistema','admin@helpdesk.it',hA,'admin',null);
    await u('Sara','Rossi','sara.r@helpdesk.it',hO,'operatore','Back Office');
    await u('Luca','Mancini','luca.m@helpdesk.it',hO,'operatore','IT / Guide');
    await u('Giulia','Ferrari','giulia.f@helpdesk.it',hO,'operatore','Back Office');
    await u('Andrea','Pellegrini','andrea.p@helpdesk.it',hO,'operatore','Management');
    await u('Roberto','Martinelli','roberto.m@helpdesk.it',hO,'operatore','IT / Guide');
    await u('Marco','Testa','marco.t@helpdesk.it',hO,'dipendente','Front Office');
    await u('Chiara','Verdi','chiara.v@helpdesk.it',hO,'dipendente','IT / Guide');
    await u('Paolo','Sorrentino','paolo.s@helpdesk.it',hO,'dipendente','Commerciale');

    const cat = (t,n) => dbRun('INSERT INTO categorie (tipo,nome) VALUES (?,?)',[t,n]);
    for (const n of ['Sistema HSW','WhatsApp Business','Talkdesk','Email / Outlook']) await cat('Software',n);
    for (const n of ['Cuffie','Telefono / SIM','Stampante','PC / Monitor']) await cat('Hardware',n);
    for (const n of ['Accessi e badge','Procedure interne','Richieste generali']) await cat('Altro',n);

    const ago = m => { const d=new Date(Date.now()-m*60000); return d.toISOString().replace('T',' ').slice(0,19); };
    const it = (cod,tit,des,area,fonte,cid,prio,stato,apertoDa,assegnatoA,ts) =>
      dbRun(`INSERT INTO ticket (codice,titolo,descrizione,area,fonte,categoria_id,priorita,stato,aperto_da,assegnato_a,creato_il,aggiornato_il) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cod,tit,des,area,fonte,cid,prio,stato,apertoDa,assegnatoA,ts,ts]);
    const ia = (tid,uid,tipo,testo,ts) =>
      dbRun('INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)',[tid,uid,tipo,testo,ts]);

    const t1=await it('HD-0042','Blocco accesso gestionale','Non riesco ad accedere al gestionale. Errore: sessione scaduta.','Front Office','Slack',1,'alta','nuovo',7,2,ago(2));
    await ia(t1,7,'creazione','Segnalazione ricevuta via Slack',ago(2));
    await ia(t1,1,'assegnazione','Ticket assegnato a Sara R.',ago(1));
    const t2=await it('HD-0041','Procedura rimborso spese non chiara','Non è chiaro se i giustificativi vanno caricati entro il mese o il trimestre.','Back Office','Email',8,'media','in_lavorazione',3,3,ago(120));
    await ia(t2,3,'creazione','Segnalazione ricevuta via email',ago(120));
    await ia(t2,3,'stato','Stato aggiornato: in lavorazione',ago(60));
    const t3=await it('HD-0040','Approvazione budget Q2 in sospeso','Richiesta in attesa da 5 giorni. Escalation necessaria.','Management','Email',11,'alta','aperto',5,5,ago(1440));
    await ia(t3,5,'creazione','Segnalazione ricevuta via email',ago(1440));
    const t4=await it('HD-0039','Guida onboarding nuovo software','Richiesta guida passo-passo per il software documentale.','IT / Guide','Telefono',8,'bassa','risolto',8,3,ago(2880));
    await ia(t4,8,'creazione','Segnalazione telefonica',ago(2880));
    await ia(t4,3,'stato','Ticket risolto: guida pubblicata',ago(1440));
    await dbRun(`UPDATE ticket SET stato='risolto', risolto_il=? WHERE id=?`,[ago(1440),t4]);
    const t5=await it('HD-0038','Listino prezzi CRM non aggiornato','Il listino non rispecchia le nuove tariffe Q2.','Commerciale','Slack',1,'media','nuovo',9,null,ago(1440));
    await ia(t5,9,'creazione','Segnalazione via Slack',ago(1440));

    console.log('✓ Dati demo inizializzati');
  }
  console.log('✓ Database Turso pronto');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'helpdesk-secret-cambiami-in-produzione',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

// ── Passport / Google OAuth ───────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
  clientID:     GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL:  GOOGLE_CALLBACK_URL,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value.toLowerCase();
    const user  = await dbQueryOne('SELECT * FROM users WHERE email=? AND attivo=1', [email]);
    if (!user) return done(null, false, { message: 'Utente non trovato' });
    return done(null, user);
  } catch(e) { return done(e); }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await dbQueryOne('SELECT * FROM users WHERE id=?', [id]);
    done(null, user || false);
  } catch(e) { done(e); }
});

// ── Auth middleware ───────────────────────────────────────────────────────────
const auth  = (req,res,next) => req.session.userId ? next() : res.status(401).json({error:'Non autenticato'});
const admin = async (req,res,next) => {
  if (!req.session.userId) return res.status(401).json({error:'Non autenticato'});
  const u = await dbQueryOne('SELECT ruolo FROM users WHERE id=?',[req.session.userId]);
  if (!u || u.ruolo !== 'admin') return res.status(403).json({error:'Accesso negato'});
  next();
};

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/login', async (req,res) => {
  const {email,password}=req.body;
  if(!email||!password) return res.status(400).json({error:'Campi mancanti'});
  const user = await dbQueryOne('SELECT * FROM users WHERE email=? AND attivo=1',[email.toLowerCase().trim()]);
  if(!user||!bcrypt.compareSync(password,user.password)) return res.status(401).json({error:'Email o password non corretti'});
  req.session.userId=user.id;
  res.json({id:user.id,nome:user.nome,cognome:user.cognome,email:user.email,ruolo:user.ruolo,area:user.area});
});

app.post('/api/logout',(req,res)=>{req.session.destroy();res.json({ok:true});});

app.get('/api/me', auth, async (req,res) => {
  res.json(await dbQueryOne('SELECT id,nome,cognome,email,ruolo,area FROM users WHERE id=?',[req.session.userId]));
});

// ── Google OAuth routes ───────────────────────────────────────────────────────
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=google_auth', session: false }),
  (req, res) => {
    req.session.userId = req.user.id;
    res.redirect('/');
  }
);

// ── Tickets ───────────────────────────────────────────────────────────────────
app.get('/api/tickets', auth, async (req,res) => {
  const {area,stato,priorita,q,assegnato_a,aperto_da,fonte}=req.query;
  let sql=`SELECT t.*,c.tipo as cat_tipo,c.nome as cat_nome,
    u1.nome||' '||u1.cognome as aperto_da_nome,
    u2.nome||' '||u2.cognome as assegnato_a_nome,
    (SELECT COUNT(*) FROM allegati a WHERE a.ticket_id=t.id) as n_allegati
    FROM ticket t
    LEFT JOIN categorie c ON t.categoria_id=c.id
    LEFT JOIN users u1 ON t.aperto_da=u1.id
    LEFT JOIN users u2 ON t.assegnato_a=u2.id WHERE 1=1`;
  const p=[];
  const me = await dbQueryOne('SELECT ruolo FROM users WHERE id=?',[req.session.userId]);
  if (me && me.ruolo === 'dipendente') {
    sql+=' AND t.aperto_da=?'; p.push(req.session.userId);
  } else {
    if(area){sql+=' AND t.area=?';p.push(area);}
    if(stato){sql+=' AND t.stato=?';p.push(stato);}
    if(priorita){sql+=' AND t.priorita=?';p.push(priorita);}
    if(fonte){sql+=' AND t.fonte=?';p.push(fonte);}
    if(assegnato_a){sql+=' AND t.assegnato_a=?';p.push(parseInt(assegnato_a,10));}
    if(aperto_da){sql+=' AND t.aperto_da=?';p.push(parseInt(aperto_da,10));}
    if(q){sql+=' AND (t.titolo LIKE ? OR t.codice LIKE ? OR t.descrizione LIKE ?)';const s='%'+q+'%';p.push(s,s,s);}
  }
  sql+=` ORDER BY CASE t.priorita WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, t.creato_il DESC`;
  res.json(await dbQuery(sql,p));
});

app.get('/api/tickets/count', auth, async (req,res) => {
  const row = await dbQueryOne('SELECT COUNT(*) as c, MAX(id) as last_id FROM ticket');
  res.json({ count: row.c, last_id: row.last_id || 0 });
});

app.get('/api/tickets/:id', auth, async (req,res) => {
  const tid = parseInt(req.params.id, 10);
  if (isNaN(tid)) return res.status(400).json({error:'ID non valido'});
  const t = await dbQueryOne(`SELECT t.*,c.tipo as cat_tipo,c.nome as cat_nome,
    u1.nome||' '||u1.cognome as aperto_da_nome,
    u2.nome||' '||u2.cognome as assegnato_a_nome
    FROM ticket t LEFT JOIN categorie c ON t.categoria_id=c.id
    LEFT JOIN users u1 ON t.aperto_da=u1.id LEFT JOIN users u2 ON t.assegnato_a=u2.id
    WHERE t.id=?`,[tid]);
  if(!t) return res.status(404).json({error:'Non trovato'});
  const meCheck = await dbQueryOne('SELECT ruolo FROM users WHERE id=?',[req.session.userId]);
  if (meCheck && meCheck.ruolo === 'dipendente' && t.aperto_da !== req.session.userId) {
    return res.status(403).json({error:'Accesso negato'});
  }
  const attivita = await dbQuery(`SELECT a.*,u.nome||' '||u.cognome as utente_nome
    FROM attivita a LEFT JOIN users u ON a.utente_id=u.id
    WHERE a.ticket_id=? ORDER BY a.creato_il ASC`,[tid]);
  const allegati = await dbQuery(`SELECT al.*,u.nome||' '||u.cognome as utente_nome
    FROM allegati al LEFT JOIN users u ON al.utente_id=u.id
    WHERE al.ticket_id=? ORDER BY al.creato_il ASC`,[tid]);
  res.json({...t, attivita, allegati});
});

app.post('/api/tickets', auth, async (req,res) => {
  const {titolo,descrizione,area,fonte,categoria_id,priorita,assegnato_a}=req.body;
  if(!titolo||!area||!fonte) return res.status(400).json({error:'Campi obbligatori mancanti'});
  const count = await dbQueryOne('SELECT COUNT(*) as c FROM ticket');
  const codice='HD-'+String((count.c||0)+43).padStart(4,'0');
  const now=new Date().toISOString().replace('T',' ').slice(0,19);
  const id = await dbRun(`INSERT INTO ticket (codice,titolo,descrizione,area,fonte,categoria_id,priorita,stato,aperto_da,assegnato_a,creato_il,aggiornato_il) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [codice,titolo,descrizione||'',area,fonte,categoria_id||null,priorita||'media','nuovo',req.session.userId,assegnato_a||null,now,now]);
  await dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[id,req.session.userId,'creazione','Ticket creato',now]);
  if(assegnato_a){
    const op = await dbQueryOne('SELECT nome,cognome FROM users WHERE id=?',[assegnato_a]);
    if(op) await dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[id,req.session.userId,'assegnazione',`Assegnato a ${op.nome} ${op.cognome}`,now]);
  }
  res.json({id,codice});
});

app.patch('/api/tickets/:id', auth, async (req,res) => {
  const {stato,assegnato_a,priorita,nota}=req.body;
  const t = await dbQueryOne('SELECT * FROM ticket WHERE id=?',[req.params.id]);
  if(!t) return res.status(404).json({error:'Non trovato'});
  const now=new Date().toISOString().replace('T',' ').slice(0,19);
  if(stato&&stato!==t.stato){
    const risolto=['risolto','chiuso'].includes(stato)?now:t.risolto_il;
    await dbRun(`UPDATE ticket SET stato=?,aggiornato_il=?,risolto_il=? WHERE id=?`,[stato,now,risolto,req.params.id]);
    await dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[req.params.id,req.session.userId,'stato',`Stato: ${stato.replace('_',' ')}`,now]);
  }
  if(assegnato_a!==undefined){
    await dbRun(`UPDATE ticket SET assegnato_a=?,aggiornato_il=? WHERE id=?`,[assegnato_a||null,now,req.params.id]);
    if(assegnato_a){
      const op = await dbQueryOne('SELECT nome,cognome FROM users WHERE id=?',[assegnato_a]);
      if(op) await dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[req.params.id,req.session.userId,'assegnazione',`Assegnato a ${op.nome} ${op.cognome}`,now]);
    }
  }
  if(priorita&&priorita!==t.priorita){
    await dbRun(`UPDATE ticket SET priorita=?,aggiornato_il=? WHERE id=?`,[priorita,now,req.params.id]);
    await dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[req.params.id,req.session.userId,'priorita',`Priorità: ${priorita}`,now]);
  }
  if(nota&&nota.trim()) await dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[req.params.id,req.session.userId,'nota',nota.trim(),now]);
  res.json({ok:true});
});

app.delete('/api/tickets/:id', admin, async (req, res) => {
  const tid = parseInt(req.params.id, 10);
  if (isNaN(tid)) return res.status(400).json({ error: 'ID non valido' });
  const t = await dbQueryOne('SELECT id FROM ticket WHERE id=?', [tid]);
  if (!t) return res.status(404).json({ error: 'Non trovato' });
  const allegati = await dbQuery('SELECT filename FROM allegati WHERE ticket_id=?', [tid]);
  allegati.forEach(a => {
    const fp = path.join(uploadsDir, a.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
  await dbRun('DELETE FROM allegati WHERE ticket_id=?', [tid]);
  await dbRun('DELETE FROM attivita WHERE ticket_id=?', [tid]);
  await dbRun('DELETE FROM ticket WHERE id=?', [tid]);
  res.json({ ok: true });
});

// ── Allegati API ──────────────────────────────────────────────────────────────
app.post('/api/tickets/:id/allegati', auth, upload.array('files', 10), async (req, res) => {
  const ticketId = parseInt(req.params.id, 10);
  if (isNaN(ticketId)) return res.status(400).json({ error: 'ID non valido' });
  const t = await dbQueryOne('SELECT id FROM ticket WHERE id=?', [ticketId]);
  if (!t) return res.status(404).json({ error: 'Ticket non trovato' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Nessun file caricato' });
  const now = new Date().toISOString().replace('T',' ').slice(0,19);
  const inserted = [];
  for (const file of req.files) {
    const id = await dbRun(
      `INSERT INTO allegati (ticket_id,utente_id,filename,originalname,size,mimetype,creato_il) VALUES (?,?,?,?,?,?,?)`,
      [ticketId, req.session.userId, file.filename, file.originalname, file.size, file.mimetype, now]
    );
    await dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,
      [ticketId, req.session.userId, 'allegato', `Allegato aggiunto: ${file.originalname}`, now]);
    inserted.push({ id, originalname: file.originalname, size: file.size });
  }
  res.json({ ok: true, allegati: inserted });
});

app.get('/api/allegati/:id/download', auth, async (req, res) => {
  const a = await dbQueryOne('SELECT * FROM allegati WHERE id=?', [parseInt(req.params.id, 10)]);
  if (!a) return res.status(404).json({ error: 'Allegato non trovato' });
  const filePath = path.join(uploadsDir, a.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File non trovato sul server' });
  res.download(filePath, a.originalname);
});

app.delete('/api/allegati/:id', auth, async (req, res) => {
  const a = await dbQueryOne('SELECT * FROM allegati WHERE id=?', [parseInt(req.params.id, 10)]);
  if (!a) return res.status(404).json({ error: 'Non trovato' });
  const filePath = path.join(uploadsDir, a.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  await dbRun('DELETE FROM allegati WHERE id=?', [parseInt(req.params.id, 10)]);
  const now = new Date().toISOString().replace('T',' ').slice(0,19);
  await dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,
    [a.ticket_id, req.session.userId, 'allegato', `Allegato rimosso: ${a.originalname}`, now]);
  res.json({ ok: true });
});

// ── Categorie ─────────────────────────────────────────────────────────────────
app.get('/api/categorie', auth, async (req,res) => res.json(await dbQuery('SELECT * FROM categorie WHERE attivo=1 ORDER BY tipo,nome')));
app.post('/api/categorie', admin, async (req,res) => {
  const{tipo,nome}=req.body;
  if(!tipo||!nome) return res.status(400).json({error:'Campi mancanti'});
  res.json({id: await dbRun('INSERT INTO categorie (tipo,nome) VALUES (?,?)',[tipo,nome])});
});
app.patch('/api/categorie/:id', admin, async (req,res) => {
  await dbRun('UPDATE categorie SET nome=? WHERE id=?',[req.body.nome,req.params.id]);
  res.json({ok:true});
});
app.delete('/api/categorie/:id', admin, async (req,res) => {
  await dbRun('UPDATE categorie SET attivo=0 WHERE id=?',[req.params.id]);
  res.json({ok:true});
});

// ── Utenti ────────────────────────────────────────────────────────────────────
app.get('/api/utenti', auth, async (req,res) => res.json(await dbQuery('SELECT id,nome,cognome,email,ruolo,area,attivo FROM users ORDER BY cognome')));
app.post('/api/utenti', admin, async (req,res) => {
  const{nome,cognome,email,password,ruolo,area}=req.body;
  if(!nome||!cognome||!email||!password) return res.status(400).json({error:'Campi mancanti'});
  try {
    res.json({id: await dbRun('INSERT INTO users (nome,cognome,email,password,ruolo,area) VALUES (?,?,?,?,?,?)',[nome,cognome,email.toLowerCase(),bcrypt.hashSync(password,10),ruolo||'dipendente',area||null])});
  } catch(e) { res.status(400).json({error:'Email già esistente'}); }
});
app.patch('/api/utenti/:id', admin, async (req,res) => {
  const{nome,cognome,email,ruolo,area,attivo,password}=req.body;
  if(password) await dbRun('UPDATE users SET password=? WHERE id=?',[bcrypt.hashSync(password,10),req.params.id]);
  if(email) await dbRun('UPDATE users SET email=? WHERE id=?',[email.toLowerCase(),req.params.id]);
  await dbRun('UPDATE users SET nome=?,cognome=?,ruolo=?,area=?,attivo=? WHERE id=?',[nome,cognome,ruolo,area,attivo!==undefined?attivo:1,req.params.id]);
  res.json({ok:true});
});

app.delete('/api/utenti/:id', admin, async (req,res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({error:'ID non valido'});
  if (id === req.session.userId) return res.status(400).json({error:'Non puoi eliminare te stesso'});
  await dbRun('DELETE FROM users WHERE id=?',[id]);
  res.json({ok:true});
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', auth, async (req,res) => {
  res.json({
    aperti:     (await dbQueryOne(`SELECT COUNT(*) as c FROM ticket WHERE stato NOT IN ('risolto','chiuso')`)).c,
    alta_prio:  (await dbQueryOne(`SELECT COUNT(*) as c FROM ticket WHERE priorita='alta' AND stato NOT IN ('risolto','chiuso')`)).c,
    oggi:       (await dbQueryOne(`SELECT COUNT(*) as c FROM ticket WHERE stato IN ('risolto','chiuso') AND DATE(risolto_il)=DATE('now')`)).c,
    nuovi_oggi: (await dbQueryOne(`SELECT COUNT(*) as c FROM ticket WHERE DATE(creato_il)=DATE('now')`)).c,
    per_area:   await dbQuery(`SELECT area,COUNT(*) as c FROM ticket WHERE stato NOT IN ('risolto','chiuso') GROUP BY area ORDER BY c DESC`),
    per_stato:  await dbQuery(`SELECT stato,COUNT(*) as c FROM ticket GROUP BY stato`)
  });
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

initDB().then(()=>{
  app.listen(PORT,()=>console.log(`\n🚀 Help Desk → http://localhost:${PORT}\n   Admin: admin@helpdesk.it / admin123\n`));
}).catch(err=>{console.error('Errore DB:',err);process.exit(1);});
