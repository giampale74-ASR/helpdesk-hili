const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

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
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB max (per video)
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf','.doc','.docx','.xls','.xlsx','.png','.jpg','.jpeg','.gif','.zip','.txt','.csv','.mp4','.mov'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// ── Database sql.js ───────────────────────────────────────────────────────────
const initSqlJs = require('sql.js');
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'helpdesk.db');

let db, dbQuery, dbQueryOne, dbRun, dbSave;

async function initDB() {
  const SQL = await initSqlJs();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = fs.existsSync(dbPath)
    ? new SQL.Database(fs.readFileSync(dbPath))
    : new SQL.Database();

  dbSave = () => fs.writeFileSync(dbPath, Buffer.from(db.export()));

  dbQuery = (sql, params = []) => {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  };
  dbQueryOne = (sql, params = []) => dbQuery(sql, params)[0] || null;
  dbRun = (sql, params = []) => {
    db.run(sql, params);
    const row = dbQueryOne('SELECT last_insert_rowid() as id');
    dbSave();
    return row ? row.id : null;
  };

  // ── Schema ───────────────────────────────────────────────────────────────────
  db.run(`
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
  dbSave();

  // ── Seed demo ─────────────────────────────────────────────────────────────────
  const cnt = dbQueryOne('SELECT COUNT(*) as c FROM users');
  if (!cnt || cnt.c === 0) {
    const hA = bcrypt.hashSync('admin123', 10);
    const hO = bcrypt.hashSync('operatore123', 10);
    const u = (n,c,e,p,r,a) => dbRun('INSERT INTO users (nome,cognome,email,password,ruolo,area) VALUES (?,?,?,?,?,?)',[n,c,e,p,r,a]);
    u('Admin','Sistema','admin@helpdesk.it',hA,'admin',null);
    u('Sara','Rossi','sara.r@helpdesk.it',hO,'operatore','Back Office');
    u('Luca','Mancini','luca.m@helpdesk.it',hO,'operatore','IT / Guide');
    u('Giulia','Ferrari','giulia.f@helpdesk.it',hO,'operatore','Back Office');
    u('Andrea','Pellegrini','andrea.p@helpdesk.it',hO,'operatore','Management');
    u('Roberto','Martinelli','roberto.m@helpdesk.it',hO,'operatore','IT / Guide');
    u('Marco','Testa','marco.t@helpdesk.it',hO,'dipendente','Front Office');
    u('Chiara','Verdi','chiara.v@helpdesk.it',hO,'dipendente','IT / Guide');
    u('Paolo','Sorrentino','paolo.s@helpdesk.it',hO,'dipendente','Commerciale');

    const cat = (t,n) => dbRun('INSERT INTO categorie (tipo,nome) VALUES (?,?)',[t,n]);
    ['Sistema HSW','WhatsApp Business','Talkdesk','Email / Outlook'].forEach(n=>cat('Software',n));
    ['Cuffie','Telefono / SIM','Stampante','PC / Monitor'].forEach(n=>cat('Hardware',n));
    ['Accessi e badge','Procedure interne','Richieste generali'].forEach(n=>cat('Altro',n));

    const ago = m => { const d=new Date(Date.now()-m*60000); return d.toISOString().replace('T',' ').slice(0,19); };
    const it = (cod,tit,des,area,fonte,cid,prio,stato,apertoDa,assegnatoA,ts) =>
      dbRun(`INSERT INTO ticket (codice,titolo,descrizione,area,fonte,categoria_id,priorita,stato,aperto_da,assegnato_a,creato_il,aggiornato_il) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cod,tit,des,area,fonte,cid,prio,stato,apertoDa,assegnatoA,ts,ts]);
    const ia = (tid,uid,tipo,testo,ts) =>
      dbRun('INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)',[tid,uid,tipo,testo,ts]);

    const t1=it('HD-0042','Blocco accesso gestionale','Non riesco ad accedere al gestionale. Errore: sessione scaduta.','Front Office','Slack',1,'alta','nuovo',7,2,ago(2));
    ia(t1,7,'creazione','Segnalazione ricevuta via Slack',ago(2));
    ia(t1,1,'assegnazione','Ticket assegnato a Sara R.',ago(1));
    const t2=it('HD-0041','Procedura rimborso spese non chiara','Non è chiaro se i giustificativi vanno caricati entro il mese o il trimestre.','Back Office','Email',8,'media','in_lavorazione',3,3,ago(120));
    ia(t2,3,'creazione','Segnalazione ricevuta via email',ago(120));
    ia(t2,3,'stato','Stato aggiornato: in lavorazione',ago(60));
    const t3=it('HD-0040','Approvazione budget Q2 in sospeso','Richiesta in attesa da 5 giorni. Escalation necessaria.','Management','Email',11,'alta','aperto',5,5,ago(1440));
    ia(t3,5,'creazione','Segnalazione ricevuta via email',ago(1440));
    const t4=it('HD-0039','Guida onboarding nuovo software','Richiesta guida passo-passo per il software documentale.','IT / Guide','Telefono',8,'bassa','risolto',8,3,ago(2880));
    ia(t4,8,'creazione','Segnalazione telefonica',ago(2880));
    ia(t4,3,'stato','Ticket risolto: guida pubblicata',ago(1440));
    dbRun(`UPDATE ticket SET stato='risolto', risolto_il=? WHERE id=?`,[ago(1440),t4]);
    const t5=it('HD-0038','Listino prezzi CRM non aggiornato','Il listino non rispecchia le nuove tariffe Q2.','Commerciale','Slack',1,'media','nuovo',9,null,ago(1440));
    ia(t5,9,'creazione','Segnalazione via Slack',ago(1440));

    dbSave();
    console.log('✓ Dati demo inizializzati');
  }
  console.log('✓ Database pronto');
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

const auth  = (req,res,next) => req.session.userId ? next() : res.status(401).json({error:'Non autenticato'});
const admin = (req,res,next) => {
  if (!req.session.userId) return res.status(401).json({error:'Non autenticato'});
  const u = dbQueryOne('SELECT ruolo FROM users WHERE id=?',[req.session.userId]);
  if (!u || u.ruolo !== 'admin') return res.status(403).json({error:'Accesso negato'});
  next();
};

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/login',(req,res)=>{
  const {email,password}=req.body;
  if(!email||!password)return res.status(400).json({error:'Campi mancanti'});
  const user=dbQueryOne('SELECT * FROM users WHERE email=? AND attivo=1',[email.toLowerCase().trim()]);
  if(!user||!bcrypt.compareSync(password,user.password))return res.status(401).json({error:'Email o password non corretti'});
  req.session.userId=user.id;
  res.json({id:user.id,nome:user.nome,cognome:user.cognome,email:user.email,ruolo:user.ruolo,area:user.area});
});
app.post('/api/logout',(req,res)=>{req.session.destroy();res.json({ok:true});});
app.get('/api/me',auth,(req,res)=>{
  res.json(dbQueryOne('SELECT id,nome,cognome,email,ruolo,area FROM users WHERE id=?',[req.session.userId]));
});

// ── Tickets ───────────────────────────────────────────────────────────────────
app.get('/api/tickets',auth,(req,res)=>{
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
  // I dipendenti vedono solo i propri ticket, indipendentemente dai filtri
  const me = dbQueryOne('SELECT ruolo FROM users WHERE id=?',[req.session.userId]);
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
  res.json(dbQuery(sql,p));
});

// ── Ticket count (per notifiche polling) ──────────────────────────────────────
app.get('/api/tickets/count',auth,(req,res)=>{
  const row = dbQueryOne('SELECT COUNT(*) as c, MAX(id) as last_id FROM ticket');
  res.json({ count: row.c, last_id: row.last_id || 0 });
});

app.get('/api/tickets/:id',auth,(req,res)=>{
  const tid = parseInt(req.params.id, 10);
  if (isNaN(tid)) return res.status(400).json({error:'ID non valido'});
  const t=dbQueryOne(`SELECT t.*,c.tipo as cat_tipo,c.nome as cat_nome,
    u1.nome||' '||u1.cognome as aperto_da_nome,
    u2.nome||' '||u2.cognome as assegnato_a_nome
    FROM ticket t LEFT JOIN categorie c ON t.categoria_id=c.id
    LEFT JOIN users u1 ON t.aperto_da=u1.id LEFT JOIN users u2 ON t.assegnato_a=u2.id
    WHERE t.id=?`,[tid]);
  if(!t)return res.status(404).json({error:'Non trovato'});
  const meCheck = dbQueryOne('SELECT ruolo FROM users WHERE id=?',[req.session.userId]);
  if (meCheck && meCheck.ruolo === 'dipendente' && t.aperto_da !== req.session.userId) {
    return res.status(403).json({error:'Accesso negato'});
  }
  const attivita=dbQuery(`SELECT a.*,u.nome||' '||u.cognome as utente_nome
    FROM attivita a LEFT JOIN users u ON a.utente_id=u.id
    WHERE a.ticket_id=? ORDER BY a.creato_il ASC`,[tid]);
  const allegati=dbQuery(`SELECT al.*,u.nome||' '||u.cognome as utente_nome
    FROM allegati al LEFT JOIN users u ON al.utente_id=u.id
    WHERE al.ticket_id=? ORDER BY al.creato_il ASC`,[tid]);
  // Normalizza i tipi per evitare problemi con BigInt di sql.js
  const normalize = obj => {
    const out = {};
    for (const [k,v] of Object.entries(obj)) out[k] = typeof v === 'bigint' ? Number(v) : v;
    return out;
  };
  res.json({...normalize(t), attivita: attivita.map(normalize), allegati: allegati.map(normalize)});
});

app.post('/api/tickets',auth,(req,res)=>{
  const {titolo,descrizione,area,fonte,categoria_id,priorita,assegnato_a}=req.body;
  if(!titolo||!area||!fonte)return res.status(400).json({error:'Campi obbligatori mancanti'});
  const count=dbQueryOne('SELECT COUNT(*) as c FROM ticket');
  const codice='HD-'+String((count.c||0)+43).padStart(4,'0');
  const now=new Date().toISOString().replace('T',' ').slice(0,19);
  const id=dbRun(`INSERT INTO ticket (codice,titolo,descrizione,area,fonte,categoria_id,priorita,stato,aperto_da,assegnato_a,creato_il,aggiornato_il) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [codice,titolo,descrizione||'',area,fonte,categoria_id||null,priorita||'media','nuovo',req.session.userId,assegnato_a||null,now,now]);
  dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[id,req.session.userId,'creazione','Ticket creato',now]);
  if(assegnato_a){
    const op=dbQueryOne('SELECT nome,cognome FROM users WHERE id=?',[assegnato_a]);
    if(op)dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[id,req.session.userId,'assegnazione',`Assegnato a ${op.nome} ${op.cognome}`,now]);
  }
  res.json({id,codice});
});

app.patch('/api/tickets/:id',auth,(req,res)=>{
  const {stato,assegnato_a,priorita,nota}=req.body;
  const t=dbQueryOne('SELECT * FROM ticket WHERE id=?',[req.params.id]);
  if(!t)return res.status(404).json({error:'Non trovato'});
  const now=new Date().toISOString().replace('T',' ').slice(0,19);
  if(stato&&stato!==t.stato){
    const risolto=['risolto','chiuso'].includes(stato)?now:t.risolto_il;
    dbRun(`UPDATE ticket SET stato=?,aggiornato_il=?,risolto_il=? WHERE id=?`,[stato,now,risolto,req.params.id]);
    dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[req.params.id,req.session.userId,'stato',`Stato: ${stato.replace('_',' ')}`,now]);
  }
  if(assegnato_a!==undefined){
    dbRun(`UPDATE ticket SET assegnato_a=?,aggiornato_il=? WHERE id=?`,[assegnato_a||null,now,req.params.id]);
    if(assegnato_a){const op=dbQueryOne('SELECT nome,cognome FROM users WHERE id=?',[assegnato_a]);
      if(op)dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[req.params.id,req.session.userId,'assegnazione',`Assegnato a ${op.nome} ${op.cognome}`,now]);}
  }
  if(priorita&&priorita!==t.priorita){
    dbRun(`UPDATE ticket SET priorita=?,aggiornato_il=? WHERE id=?`,[priorita,now,req.params.id]);
    dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[req.params.id,req.session.userId,'priorita',`Priorità: ${priorita}`,now]);
  }
  if(nota&&nota.trim())dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[req.params.id,req.session.userId,'nota',nota.trim(),now]);
  dbSave();
  res.json({ok:true});
});

app.delete('/api/tickets/:id', admin, (req, res) => {
  const tid = parseInt(req.params.id, 10);
  if (isNaN(tid)) return res.status(400).json({ error: 'ID non valido' });
  const t = dbQueryOne('SELECT id FROM ticket WHERE id=?', [tid]);
  if (!t) return res.status(404).json({ error: 'Non trovato' });
  // Elimina allegati fisici dal disco
  const allegati = dbQuery('SELECT filename FROM allegati WHERE ticket_id=?', [tid]);
  allegati.forEach(a => {
    const fp = path.join(uploadsDir, a.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
  // Elimina record correlati e il ticket
  dbRun('DELETE FROM allegati WHERE ticket_id=?', [tid]);
  dbRun('DELETE FROM attivita WHERE ticket_id=?', [tid]);
  dbRun('DELETE FROM ticket WHERE id=?', [tid]);
  res.json({ ok: true });
});

// ── Allegati API ──────────────────────────────────────────────────────────────
app.post('/api/tickets/:id/allegati', auth, upload.array('files', 10), (req, res) => {
  const ticketId = parseInt(req.params.id, 10);
  if (isNaN(ticketId)) return res.status(400).json({ error: 'ID non valido' });
  const t = dbQueryOne('SELECT id FROM ticket WHERE id=?', [ticketId]);
  if (!t) return res.status(404).json({ error: 'Ticket non trovato' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Nessun file caricato' });

  const now = new Date().toISOString().replace('T',' ').slice(0,19);
  const inserted = [];
  for (const file of req.files) {
    const id = dbRun(
      `INSERT INTO allegati (ticket_id,utente_id,filename,originalname,size,mimetype,creato_il) VALUES (?,?,?,?,?,?,?)`,
      [ticketId, req.session.userId, file.filename, file.originalname, file.size, file.mimetype, now]
    );
    dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,
      [ticketId, req.session.userId, 'allegato', `Allegato aggiunto: ${file.originalname}`, now]);
    inserted.push({ id, originalname: file.originalname, size: file.size });
  }
  res.json({ ok: true, allegati: inserted });
});

app.get('/api/allegati/:id/download', auth, (req, res) => {
  const a = dbQueryOne('SELECT * FROM allegati WHERE id=?', [parseInt(req.params.id, 10)]);
  if (!a) return res.status(404).json({ error: 'Allegato non trovato' });
  const filePath = path.join(uploadsDir, a.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File non trovato sul server' });
  res.download(filePath, a.originalname);
});

app.delete('/api/allegati/:id', auth, (req, res) => {
  const a = dbQueryOne('SELECT * FROM allegati WHERE id=?', [parseInt(req.params.id, 10)]);
  if (!a) return res.status(404).json({ error: 'Non trovato' });
  const filePath = path.join(uploadsDir, a.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  dbRun('DELETE FROM allegati WHERE id=?', [parseInt(req.params.id, 10)]);
  const now = new Date().toISOString().replace('T',' ').slice(0,19);
  dbRun(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,
    [a.ticket_id, req.session.userId, 'allegato', `Allegato rimosso: ${a.originalname}`, now]);
  res.json({ ok: true });
});

// ── Categorie ─────────────────────────────────────────────────────────────────
app.get('/api/categorie',auth,(req,res)=>res.json(dbQuery('SELECT * FROM categorie WHERE attivo=1 ORDER BY tipo,nome')));
app.post('/api/categorie',admin,(req,res)=>{
  const{tipo,nome}=req.body;if(!tipo||!nome)return res.status(400).json({error:'Campi mancanti'});
  res.json({id:dbRun('INSERT INTO categorie (tipo,nome) VALUES (?,?)',[tipo,nome])});
});
app.patch('/api/categorie/:id',admin,(req,res)=>{dbRun('UPDATE categorie SET nome=? WHERE id=?',[req.body.nome,req.params.id]);res.json({ok:true});});
app.delete('/api/categorie/:id',admin,(req,res)=>{dbRun('UPDATE categorie SET attivo=0 WHERE id=?',[req.params.id]);res.json({ok:true});});

// ── Utenti ────────────────────────────────────────────────────────────────────
app.get('/api/utenti',auth,(req,res)=>res.json(dbQuery('SELECT id,nome,cognome,email,ruolo,area,attivo FROM users ORDER BY cognome')));
app.post('/api/utenti',admin,(req,res)=>{
  const{nome,cognome,email,password,ruolo,area}=req.body;
  if(!nome||!cognome||!email||!password)return res.status(400).json({error:'Campi mancanti'});
  try{res.json({id:dbRun('INSERT INTO users (nome,cognome,email,password,ruolo,area) VALUES (?,?,?,?,?,?)',[nome,cognome,email.toLowerCase(),bcrypt.hashSync(password,10),ruolo||'dipendente',area||null])});}
  catch(e){res.status(400).json({error:'Email già esistente'});}
});
app.patch('/api/utenti/:id',admin,(req,res)=>{
  const{nome,cognome,ruolo,area,attivo,password}=req.body;
  if(password)dbRun('UPDATE users SET password=? WHERE id=?',[bcrypt.hashSync(password,10),req.params.id]);
  dbRun('UPDATE users SET nome=?,cognome=?,ruolo=?,area=?,attivo=? WHERE id=?',[nome,cognome,ruolo,area,attivo!==undefined?attivo:1,req.params.id]);
  res.json({ok:true});
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats',auth,(req,res)=>{
  res.json({
    aperti:    dbQueryOne(`SELECT COUNT(*) as c FROM ticket WHERE stato NOT IN ('risolto','chiuso')`).c,
    alta_prio: dbQueryOne(`SELECT COUNT(*) as c FROM ticket WHERE priorita='alta' AND stato NOT IN ('risolto','chiuso')`).c,
    oggi:      dbQueryOne(`SELECT COUNT(*) as c FROM ticket WHERE stato IN ('risolto','chiuso') AND DATE(risolto_il)=DATE('now')`).c,
    nuovi_oggi:dbQueryOne(`SELECT COUNT(*) as c FROM ticket WHERE DATE(creato_il)=DATE('now')`).c,
    per_area:  dbQuery(`SELECT area,COUNT(*) as c FROM ticket WHERE stato NOT IN ('risolto','chiuso') GROUP BY area ORDER BY c DESC`),
    per_stato: dbQuery(`SELECT stato,COUNT(*) as c FROM ticket GROUP BY stato`)
  });
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

initDB().then(()=>{
  app.listen(PORT,()=>console.log(`\n🚀 Help Desk → http://localhost:${PORT}\n   Admin: admin@helpdesk.it / admin123\n`));
}).catch(err=>{console.error('Errore DB:',err);process.exit(1);});
