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
const PORT = process.env.PORT || 3000;

// ── Google OAuth config ───────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL  = process.env.GOOGLE_CALLBACK_URL || 'https://hd.hilitravel.com/auth/google/callback';

// ── Gmail / Nodemailer config ────────────────────────────────────────────────
async function getGmailAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
  return data.access_token;
}

function makeRawEmail(to, from, subject, html) {
  const boundary = 'boundary_' + Date.now();
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html).toString('base64'),
    `--${boundary}--`,
  ].join('\r\n');
  return Buffer.from(raw).toString('base64url');
}

const FROM_EMAIL = `"Hili Help Desk" <${process.env.GMAIL_USER}>`;

async function sendEmail(to, subject, html) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_REFRESH_TOKEN) {
    return console.log('[EMAIL] Gmail non configurato');
  }
  if (!to) return;
  try {
    const accessToken = await getGmailAccessToken();
    const raw = makeRawEmail(to, FROM_EMAIL, subject, html);
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    });
    const data = await res.json();
    if (data.id) {
      console.log('[EMAIL] Inviata a:', to, 'id:', data.id);
    } else {
      console.error('[EMAIL] Errore API:', JSON.stringify(data));
    }
  } catch(e) { console.error('[EMAIL] Errore:', e.message); }
}

function emailNuovoTicket(utente, ticket, apertoDa) {
  const prioColors = {critical:'#7C3AED',high:'#DC2626',medium:'#D97706',low:'#16A34A'};
  const prioLabels = {critical:'Critical',high:'High',medium:'Medium',low:'Low'};
  const colore = prioColors[ticket.priorita] || '#6B7280';
  const prioLabel = prioLabels[ticket.priorita] || ticket.priorita;
  return `
    <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;">
      <div style="background:#1E2433;padding:16px 24px;">
        <span style="color:#fff;font-size:18px;font-weight:700;letter-spacing:1px;">HILI</span>
        <span style="color:#94A3B8;font-size:12px;margin-left:8px;">Help Desk</span>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 8px;color:#374151;font-size:14px;">È stata aperta una nuova segnalazione da <strong>${apertoDa}</strong>.</p>
        <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:6px;padding:16px;margin:16px 0;">
          <div style="font-size:12px;color:#6B7280;margin-bottom:4px;">${ticket.codice} · ${ticket.area}</div>
          <div style="font-size:15px;font-weight:600;color:#111827;margin-bottom:12px;">${ticket.titolo}</div>
          <span style="display:inline-block;padding:4px 12px;border-radius:20px;background:${colore}22;color:${colore};font-size:12px;font-weight:700;">${prioLabel}</span>
        </div>
        <p style="margin:0;color:#6B7280;font-size:12px;">Accedi all'Help Desk per prendere in carico la segnalazione.</p>
      </div>
      <div style="background:#F9FAFB;padding:12px 24px;border-top:1px solid #E5E7EB;">
        <p style="margin:0;color:#9CA3AF;font-size:11px;">Hili Travel — Help Desk Interno · Non rispondere a questa email</p>
      </div>
    </div>`;
}

function emailStatoTicket(utente, ticket, nuovoStato) {
  const statiLabel = {nuovo:'NEW',aperto:'OPEN',in_lavorazione:'IN PROGRESS',risolto:'RESOLVED',chiuso:'CLOSED'};
  const colori = {nuovo:'#2563EB',aperto:'#B45309',in_lavorazione:'#EA580C',risolto:'#166534',chiuso:'#6B7280'};
  const stato = statiLabel[nuovoStato] || nuovoStato;
  const colore = colori[nuovoStato] || '#6B7280';
  return `
    <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;">
      <div style="background:#1E2433;padding:16px 24px;">
        <span style="color:#fff;font-size:18px;font-weight:700;letter-spacing:1px;">HILI</span>
        <span style="color:#94A3B8;font-size:12px;margin-left:8px;">Help Desk</span>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 8px;color:#374151;font-size:14px;">Ciao <strong>${utente.nome}</strong>,</p>
        <p style="margin:0 0 16px;color:#374151;font-size:14px;">lo stato del tuo ticket è stato aggiornato.</p>
        <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:6px;padding:16px;margin-bottom:16px;">
          <div style="font-size:12px;color:#6B7280;margin-bottom:4px;">${ticket.codice}</div>
          <div style="font-size:15px;font-weight:600;color:#111827;margin-bottom:12px;">${ticket.titolo}</div>
          <span style="display:inline-block;padding:4px 12px;border-radius:20px;background:${colore}22;color:${colore};font-size:12px;font-weight:700;">${stato}</span>
        </div>
        <p style="margin:0;color:#6B7280;font-size:12px;">Accedi all'Help Desk per maggiori dettagli.</p>
      </div>
      <div style="background:#F9FAFB;padding:12px 24px;border-top:1px solid #E5E7EB;">
        <p style="margin:0;color:#9CA3AF;font-size:11px;">Hili Travel — Help Desk Interno · Non rispondere a questa email</p>
      </div>
    </div>`;
}

function emailComunicazione(utente, ticket, messaggio) {
  return `
    <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;">
      <div style="background:#1E2433;padding:16px 24px;">
        <span style="color:#fff;font-size:18px;font-weight:700;letter-spacing:1px;">HILI</span>
        <span style="color:#94A3B8;font-size:12px;margin-left:8px;">Help Desk</span>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 8px;color:#374151;font-size:14px;">Ciao <strong>${utente.nome}</strong>,</p>
        <p style="margin:0 0 16px;color:#374151;font-size:14px;">hai ricevuto una nuova comunicazione dall'Help Desk sul tuo ticket.</p>
        <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:6px;padding:16px;margin-bottom:16px;">
          <div style="font-size:12px;color:#6B7280;margin-bottom:4px;">${ticket.codice}</div>
          <div style="font-size:15px;font-weight:600;color:#111827;margin-bottom:12px;">${ticket.titolo}</div>
          <div style="background:#EFF6FF;border-left:3px solid #2563EB;padding:12px;border-radius:0 4px 4px 0;font-size:13px;color:#1E40AF;">${messaggio}</div>
        </div>
        <p style="margin:0;color:#6B7280;font-size:12px;">Accedi all'Help Desk per rispondere.</p>
      </div>
      <div style="background:#F9FAFB;padding:12px 24px;border-top:1px solid #E5E7EB;">
        <p style="margin:0;color:#9CA3AF;font-size:11px;">Hili Travel — Help Desk Interno · Non rispondere a questa email</p>
      </div>
    </div>`;
}

// ── Cloudinary config ────────────────────────────────────────────────────────
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

// ── Upload config ─────────────────────────────────────────────────────────────
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

// ── Database Azure SQL ────────────────────────────────────────────────────────
// Connection pool (singleton)
let pool;

// ── Ora italiana (UTC+2 estate / UTC+1 inverno) ───────────────────────────────
function nowIT() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Rome' }).replace('T', ' ').slice(0, 19);
}

const azureSqlConfig = {
  server:   process.env.AZURE_SQL_SERVER,   // e.g. myserver.database.windows.net
  database: process.env.AZURE_SQL_DATABASE,
  user:     process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  port:     parseInt(process.env.AZURE_SQL_PORT || '1433', 10),
  options: {
    encrypt: true,              // required for Azure SQL
    trustServerCertificate: false,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

// ── DB helpers ────────────────────────────────────────────────────────────────
// Converts positional ? placeholders to named @p0, @p1, ... for mssql
function buildRequest(transaction) {
  return transaction ? transaction.request() : pool.request();
}

// Normalize a value returned by mssql: convert Date objects → "YYYY-MM-DD HH:mm:ss" strings
function normalizeVal(v) {
  if (v instanceof Date) {
    const pad = n => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth()+1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
  }
  return v;
}

async function dbQuery(sqlText, params = []) {
  const req = buildRequest();
  // Replace ? with @p0, @p1, ...
  let i = 0;
  const namedSql = sqlText.replace(/\?/g, () => `@p${i++}`);
  params.forEach((v, idx) => req.input(`p${idx}`, v !== undefined ? v : null));
  const result = await req.query(namedSql);
  // Normalize Date objects → strings so the frontend always gets "YYYY-MM-DD HH:mm:ss"
  return (result.recordset || []).map(row => {
    const out = {};
    for (const key of Object.keys(row)) out[key] = normalizeVal(row[key]);
    return out;
  });
}

async function dbQueryOne(sqlText, params = []) {
  const rows = await dbQuery(sqlText, params);
  return rows[0] || null;
}

// Returns the last inserted ID (uses OUTPUT INSERTED.id pattern when needed)
// For INSERT statements, caller should use dbInsert; dbRun for non-INSERT DML.
async function dbRun(sqlText, params = []) {
  const req = buildRequest();
  let i = 0;
  const namedSql = sqlText.replace(/\?/g, () => `@p${i++}`);
  params.forEach((v, idx) => req.input(`p${idx}`, v !== undefined ? v : null));
  const result = await req.query(namedSql);
  // For INSERT ... OUTPUT INSERTED.id
  if (result.recordset && result.recordset.length > 0 && result.recordset[0].id !== undefined) {
    return Number(result.recordset[0].id);
  }
  return null;
}

// Helper: INSERT and return new ID using OUTPUT INSERTED.id
// Rewrites:  INSERT INTO t (cols) VALUES (...)  →  INSERT INTO t (cols) OUTPUT INSERTED.id VALUES (...)
async function dbInsert(sqlText, params = []) {
  // Inject OUTPUT INSERTED.id after table name + columns, before VALUES
  const insertSql = sqlText.replace(
    /^(INSERT\s+INTO\s+\S+\s*(?:\([^)]*\))?)\s*(VALUES)/i,
    '$1 OUTPUT INSERTED.id $2'
  );
  return dbRun(insertSql, params);
}

async function initDB() {
  pool = await sql.connect(azureSqlConfig);

  // ── Schema ────────────────────────────────────────────────────────────────────
  await pool.request().query(`
    IF OBJECT_ID('users','U') IS NULL
    CREATE TABLE users (
      id        INT IDENTITY(1,1) PRIMARY KEY,
      nome      NVARCHAR(100) NOT NULL,
      cognome   NVARCHAR(100) NOT NULL,
      email     NVARCHAR(255) NOT NULL UNIQUE,
      password  NVARCHAR(255) NOT NULL,
      ruolo     NVARCHAR(50)  NOT NULL DEFAULT 'operatore',
      area      NVARCHAR(100),
      attivo    BIT           NOT NULL DEFAULT 1,
      creato_il NVARCHAR(20)  NOT NULL DEFAULT (FORMAT(GETDATE(),'yyyy-MM-dd HH:mm:ss'))
    )`);

  await pool.request().query(`
    IF OBJECT_ID('categorie','U') IS NULL
    CREATE TABLE categorie (
      id     INT IDENTITY(1,1) PRIMARY KEY,
      tipo   NVARCHAR(50)  NOT NULL,
      nome   NVARCHAR(100) NOT NULL,
      attivo BIT           NOT NULL DEFAULT 1
    )`);

  await pool.request().query(`
    IF OBJECT_ID('ticket','U') IS NULL
    CREATE TABLE ticket (
      id            INT IDENTITY(1,1) PRIMARY KEY,
      codice        NVARCHAR(20)  NOT NULL UNIQUE,
      titolo        NVARCHAR(255) NOT NULL,
      descrizione   NVARCHAR(MAX),
      area          NVARCHAR(100) NOT NULL,
      fonte         NVARCHAR(50)  NOT NULL,
      categoria_id  INT,
      priorita      NVARCHAR(20)  NOT NULL DEFAULT 'media',
      stato         NVARCHAR(30)  NOT NULL DEFAULT 'nuovo',
      aperto_da     INT,
      assegnato_a   INT,
      creato_il     NVARCHAR(20)  NOT NULL DEFAULT (FORMAT(GETDATE(),'yyyy-MM-dd HH:mm:ss')),
      aggiornato_il NVARCHAR(20)  NOT NULL DEFAULT (FORMAT(GETDATE(),'yyyy-MM-dd HH:mm:ss')),
      risolto_il    NVARCHAR(20)
    )`);

  await pool.request().query(`
    IF OBJECT_ID('attivita','U') IS NULL
    CREATE TABLE attivita (
      id        INT IDENTITY(1,1) PRIMARY KEY,
      ticket_id INT           NOT NULL,
      utente_id INT,
      tipo      NVARCHAR(30)  NOT NULL,
      testo     NVARCHAR(MAX) NOT NULL,
      creato_il NVARCHAR(20)  NOT NULL DEFAULT (FORMAT(GETDATE(),'yyyy-MM-dd HH:mm:ss'))
    )`);

  await pool.request().query(`
    IF OBJECT_ID('aree','U') IS NULL
    CREATE TABLE aree (
      id     INT IDENTITY(1,1) PRIMARY KEY,
      nome   NVARCHAR(100) NOT NULL UNIQUE,
      ordine INT           NOT NULL DEFAULT 0,
      attivo BIT           NOT NULL DEFAULT 1
    )`);

  // Seed aree di default se vuote
  const cntAree = await dbQueryOne('SELECT COUNT(*) AS c FROM aree');
  if (!cntAree || cntAree.c === 0) {
    for (const [i, a] of ['Front Office','Back Office','Management','IT / Guide','Commerciale'].entries()) {
      await dbInsert('INSERT INTO aree (nome,ordine) VALUES (?,?)', [a, i]);
    }
  }

  await pool.request().query(`
    IF OBJECT_ID('annunci','U') IS NULL
    CREATE TABLE annunci (
      id        INT IDENTITY(1,1) PRIMARY KEY,
      titolo    NVARCHAR(255) NOT NULL,
      testo     NVARCHAR(MAX) NOT NULL,
      attivo    BIT           NOT NULL DEFAULT 1,
      creato_il NVARCHAR(20)  NOT NULL DEFAULT (FORMAT(GETDATE(),'yyyy-MM-dd HH:mm:ss')),
      creato_da INT
    )`);

  await pool.request().query(`
    IF OBJECT_ID('faq','U') IS NULL
    CREATE TABLE faq (
      id        INT IDENTITY(1,1) PRIMARY KEY,
      domanda   NVARCHAR(MAX) NOT NULL,
      risposta  NVARCHAR(MAX) NOT NULL,
      ordine    INT           NOT NULL DEFAULT 0,
      attivo    BIT           NOT NULL DEFAULT 1,
      creato_il NVARCHAR(20)  NOT NULL DEFAULT (FORMAT(GETDATE(),'yyyy-MM-dd HH:mm:ss'))
    )`);

  await pool.request().query(`
    IF OBJECT_ID('feedback','U') IS NULL
    CREATE TABLE feedback (
      id        INT IDENTITY(1,1) PRIMARY KEY,
      ticket_id INT           NOT NULL UNIQUE,
      utente_id INT           NOT NULL,
      voto      INT           NOT NULL,
      commento  NVARCHAR(MAX),
      creato_il NVARCHAR(20)  NOT NULL DEFAULT (FORMAT(GETDATE(),'yyyy-MM-dd HH:mm:ss'))
    )`);

  await pool.request().query(`
    IF OBJECT_ID('allegati','U') IS NULL
    CREATE TABLE allegati (
      id           INT IDENTITY(1,1) PRIMARY KEY,
      ticket_id    INT           NOT NULL,
      utente_id    INT,
      filename     NVARCHAR(500) NOT NULL,
      originalname NVARCHAR(255) NOT NULL,
      size         BIGINT        NOT NULL,
      mimetype     NVARCHAR(100),
      creato_il    NVARCHAR(20)  NOT NULL DEFAULT (FORMAT(GETDATE(),'yyyy-MM-dd HH:mm:ss'))
    )`);

  // ── Seed demo ─────────────────────────────────────────────────────────────────
  const cnt = await dbQueryOne('SELECT COUNT(*) AS c FROM users');
  if (!cnt || cnt.c === 0) {
    const hA = bcrypt.hashSync('admin123', 10);
    const hO = bcrypt.hashSync('operatore123', 10);
    const u = (n,c,e,p,r,a) => dbInsert('INSERT INTO users (nome,cognome,email,password,ruolo,area) VALUES (?,?,?,?,?,?)',[n,c,e,p,r,a]);
    await u('Admin','Sistema','admin@helpdesk.it',hA,'admin',null);
    await u('Sara','Rossi','sara.r@helpdesk.it',hO,'operatore','Back Office');
    await u('Luca','Mancini','luca.m@helpdesk.it',hO,'operatore','IT / Guide');
    await u('Giulia','Ferrari','giulia.f@helpdesk.it',hO,'operatore','Back Office');
    await u('Andrea','Pellegrini','andrea.p@helpdesk.it',hO,'operatore','Management');
    await u('Roberto','Martinelli','roberto.m@helpdesk.it',hO,'operatore','IT / Guide');
    await u('Marco','Testa','marco.t@helpdesk.it',hO,'dipendente','Front Office');
    await u('Chiara','Verdi','chiara.v@helpdesk.it',hO,'dipendente','IT / Guide');
    await u('Paolo','Sorrentino','paolo.s@helpdesk.it',hO,'dipendente','Commerciale');

    const cat = (t,n) => dbInsert('INSERT INTO categorie (tipo,nome) VALUES (?,?)',[t,n]);
    for (const n of ['Sistema HSW','WhatsApp Business','Talkdesk','Email / Outlook']) await cat('Software',n);
    for (const n of ['Cuffie','Telefono / SIM','Stampante','PC / Monitor']) await cat('Hardware',n);
    for (const n of ['Accessi e badge','Procedure interne','Richieste generali']) await cat('Altro',n);

    const ago = m => { return new Date(Date.now()-m*60000).toLocaleString('sv-SE', { timeZone: 'Europe/Rome' }).replace('T',' ').slice(0,19); };
    const it = (cod,tit,des,area,fonte,cid,prio,stato,apertoDa,assegnatoA,ts) =>
      dbInsert(`INSERT INTO ticket (codice,titolo,descrizione,area,fonte,categoria_id,priorita,stato,aperto_da,assegnato_a,creato_il,aggiornato_il) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cod,tit,des,area,fonte,cid,prio,stato,apertoDa,assegnatoA,ts,ts]);
    const ia = (tid,uid,tipo,testo,ts) =>
      dbInsert('INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)',[tid,uid,tipo,testo,ts]);

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

  // ── Migrazione priorità vecchie → nuove ──────────────────────────────────────
  await dbRun("UPDATE ticket SET priorita='critical' WHERE priorita='massima'");
  await dbRun("UPDATE ticket SET priorita='high'     WHERE priorita='alta'");
  await dbRun("UPDATE ticket SET priorita='medium'   WHERE priorita='media'");
  await dbRun("UPDATE ticket SET priorita='low'      WHERE priorita='bassa'");
  console.log('✓ Database Azure SQL pronto');
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

// ── SSO dalla Dashboard Hub ──────────────────────────────────────────────────
// Riceve un JWT firmato dalla dashboard, verifica l'email nel DB e crea la sessione.
// La dashboard usa lo stesso JWT_SECRET → il token è affidabile.
app.get('/auth/sso', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/?error=sso_token_mancante');

  try {
    // Verifica e decodifica il token firmato dalla dashboard
    const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
    const payload = jwt.verify(token, secret);
    const email = (payload.email || '').toLowerCase().trim();
    if (!email) return res.redirect('/?error=sso_email_mancante');

    // Cerca l'utente nel database tramite email
    const user = await dbQueryOne(
      'SELECT * FROM users WHERE email=? AND attivo=1',
      [email]
    );

    if (!user) {
      console.warn('[SSO] Utente non trovato per email:', email);
      return res.redirect('/?error=sso_utente_non_trovato');
    }

    // Crea la sessione — esattamente come fa il login normale
    req.session.userId = user.id;
    console.log('[SSO] Login automatico per:', email, '→ userId:', user.id);
    res.redirect('/');

  } catch (err) {
    console.error('[SSO] Errore verifica token:', err.message);
    res.redirect('/?error=sso_token_non_valido');
  }
});

// ── API Stats per Dashboard Hub ──────────────────────────────────────────────
// Accetta JWT firmato dalla dashboard, restituisce conteggio ticket aperti
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Token mancante' });

    const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
    const payload = jwt.verify(token, secret);
    const email = (payload.email || '').toLowerCase().trim();
    if (!email) return res.status(401).json({ error: 'Email mancante' });

    // Trova l'utente per ruolo
    const user = await dbQueryOne('SELECT id, ruolo FROM users WHERE email=?', [email]);
    if (!user) return res.json({ open: 0, assigned: 0 });

    let row;
    if (user.ruolo === 'dipendente') {
      // Dipendente: solo i ticket aperti DA lui
      row = await dbQueryOne(
        "SELECT COUNT(*) AS c FROM ticket WHERE stato NOT IN ('chiuso','risolto') AND aperto_da=?",
        [user.id]
      );
    } else {
      // Admin/operatore: tutti i ticket aperti
      row = await dbQueryOne(
        "SELECT COUNT(*) AS c FROM ticket WHERE stato NOT IN ('chiuso','risolto')"
      );
    }
    res.json({ open: row?.c || 0, assigned: 0 });
  } catch(e) {
    console.error('[dashboard/stats] errore:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Tickets ───────────────────────────────────────────────────────────────────
app.get('/api/tickets', auth, async (req,res) => {
  const {area,stato,priorita,q,assegnato_a,aperto_da,fonte}=req.query;
  // NOTE: SQL Server string concatenation uses + instead of ||
  let sqlText=`SELECT t.*,c.tipo as cat_tipo,c.nome as cat_nome,
    u1.nome+' '+u1.cognome as aperto_da_nome,
    u2.nome+' '+u2.cognome as assegnato_a_nome,
    (SELECT COUNT(*) FROM allegati a WHERE a.ticket_id=t.id) as n_allegati
    FROM ticket t
    LEFT JOIN categorie c ON t.categoria_id=c.id
    LEFT JOIN users u1 ON t.aperto_da=u1.id
    LEFT JOIN users u2 ON t.assegnato_a=u2.id WHERE 1=1`;
  const p=[];
  const me = await dbQueryOne('SELECT ruolo FROM users WHERE id=?',[req.session.userId]);
  if (me && me.ruolo === 'dipendente') {
    sqlText+=' AND t.aperto_da=?'; p.push(req.session.userId);
    if(stato){sqlText+=' AND t.stato=?';p.push(stato);}
    if(q){sqlText+=' AND (t.titolo LIKE ? OR t.codice LIKE ? OR t.descrizione LIKE ?)';const s='%'+q+'%';p.push(s,s,s);}
  } else {
    if(area){sqlText+=' AND t.area=?';p.push(area);}
    if(stato){sqlText+=' AND t.stato=?';p.push(stato);}
    if(priorita){sqlText+=' AND t.priorita=?';p.push(priorita);}
    if(fonte){sqlText+=' AND t.fonte=?';p.push(fonte);}
    if(assegnato_a){sqlText+=' AND t.assegnato_a=?';p.push(parseInt(assegnato_a,10));}
    if(aperto_da){sqlText+=' AND t.aperto_da=?';p.push(parseInt(aperto_da,10));}
    if(q){sqlText+=' AND (t.titolo LIKE ? OR t.codice LIKE ? OR t.descrizione LIKE ?)';const s='%'+q+'%';p.push(s,s,s);}
  }
  sqlText+=` ORDER BY CASE t.priorita WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, t.creato_il DESC`;
  res.json(await dbQuery(sqlText,p));
});

app.get('/api/tickets/count', auth, async (req,res) => {
  const row = await dbQueryOne('SELECT COUNT(*) AS c, MAX(id) AS last_id FROM ticket');
  res.json({ count: row.c, last_id: row.last_id || 0 });
});

// Restituisce le attività nuove dopo since_id (per notifiche real-time)
app.get('/api/attivita/latest', auth, async (req,res) => {
  const userId = req.session.userId;
  const sinceId = parseInt(req.query.since || '0', 10);
  const user = await dbQueryOne('SELECT ruolo FROM users WHERE id=?', [userId]);

  let rows;
  if (user && user.ruolo === 'dipendente') {
    rows = await dbQuery(
      `SELECT a.id, a.tipo, a.testo, a.creato_il, a.ticket_id, a.utente_id,
        t.codice, t.titolo,
        u.nome+' '+u.cognome AS utente_nome
       FROM attivita a
       JOIN ticket t ON t.id = a.ticket_id
       LEFT JOIN users u ON u.id = a.utente_id
       WHERE t.aperto_da = ? AND a.id > ?
         AND a.tipo IN ('stato','nota','allegato')
         AND NOT (a.tipo = 'nota' AND a.testo LIKE '[Interno]%')
         AND NOT (a.utente_id = ? AND a.tipo != 'stato')
       ORDER BY a.id ASC`,
      [userId, sinceId, userId]
    );
  } else {
    rows = await dbQuery(
      `SELECT a.id, a.tipo, a.testo, a.creato_il, a.ticket_id, a.utente_id,
        t.codice, t.titolo,
        u.nome+' '+u.cognome AS utente_nome
       FROM attivita a
       JOIN ticket t ON t.id = a.ticket_id
       LEFT JOIN users u ON u.id = a.utente_id
       WHERE a.utente_id != ? AND a.id > ?
         AND a.tipo IN ('stato','nota','allegato','assegnazione','creazione','feedback')
         AND NOT (a.tipo = 'nota' AND a.testo LIKE '[Interno]%')
       ORDER BY a.id ASC`,
      [userId, sinceId]
    );
  }

  const last_activity_id = rows.length > 0 ? Number(rows[rows.length-1].id) : sinceId;
  res.json({ last_activity_id, activities: rows });
});

// ── Bulk delete tickets ──────────────────────────────────────────────────────
app.delete('/api/tickets/bulk', admin, async (req,res) => {
  const {ids} = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({error:'Nessun ticket specificato'});
  for (const id of ids) {
    const allegati = await dbQuery('SELECT * FROM allegati WHERE ticket_id=?',[id]);
    for (const a of allegati) {
      if (useCloudinary && a.filename && a.filename.includes('helpdesk/')) {
        try { await cloudinary.uploader.destroy(a.filename); } catch(e) {}
      }
    }
    await dbRun('DELETE FROM allegati WHERE ticket_id=?',[id]);
    await dbRun('DELETE FROM attivita WHERE ticket_id=?',[id]);
    await dbRun('DELETE FROM feedback WHERE ticket_id=?',[id]);
    await dbRun('DELETE FROM ticket WHERE id=?',[id]);
  }
  res.json({ok:true, deleted: ids.length});
});

app.get('/api/tickets/:id', auth, async (req,res) => {
  const tid = parseInt(req.params.id, 10);
  if (isNaN(tid)) return res.status(400).json({error:'ID non valido'});
  const t = await dbQueryOne(`SELECT t.*,c.tipo as cat_tipo,c.nome as cat_nome,
    u1.nome+' '+u1.cognome AS aperto_da_nome,
    u2.nome+' '+u2.cognome AS assegnato_a_nome
    FROM ticket t LEFT JOIN categorie c ON t.categoria_id=c.id
    LEFT JOIN users u1 ON t.aperto_da=u1.id LEFT JOIN users u2 ON t.assegnato_a=u2.id
    WHERE t.id=?`,[tid]);
  if(!t) return res.status(404).json({error:'Non trovato'});
  const meCheck = await dbQueryOne('SELECT ruolo FROM users WHERE id=?',[req.session.userId]);
  if (meCheck && meCheck.ruolo === 'dipendente' && t.aperto_da !== req.session.userId) {
    return res.status(403).json({error:'Accesso negato'});
  }
  const attivita = await dbQuery(`SELECT a.*,u.nome+' '+u.cognome AS utente_nome
    FROM attivita a LEFT JOIN users u ON a.utente_id=u.id
    WHERE a.ticket_id=? ORDER BY a.creato_il ASC`,[tid]);
  const allegati = await dbQuery(`SELECT al.*,u.nome+' '+u.cognome AS utente_nome
    FROM allegati al LEFT JOIN users u ON al.utente_id=u.id
    WHERE al.ticket_id=? ORDER BY al.creato_il ASC`,[tid]);
  res.json({...t, attivita, allegati});
});

app.post('/api/tickets', auth, async (req,res) => {
  const {titolo,descrizione,area,fonte,categoria_id,priorita,assegnato_a}=req.body;
  if(!titolo||!area||!fonte) return res.status(400).json({error:'Campi obbligatori mancanti'});
  // Use MAX(codice) to avoid duplicates
  const lastCodice = await dbQueryOne("SELECT MAX(CAST(SUBSTRING(codice,4,10) AS INT)) AS n FROM ticket WHERE codice LIKE 'HD-%'");
  const nextN = (lastCodice && lastCodice.n ? lastCodice.n : 0) + 1;
  const codice = 'HD-' + String(nextN).padStart(4,'0');
  const now=nowIT();
  const id = await dbInsert(
    `INSERT INTO ticket (codice,titolo,descrizione,area,fonte,categoria_id,priorita,stato,aperto_da,assegnato_a,creato_il,aggiornato_il) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [codice,titolo,descrizione||'',area,fonte,categoria_id||null,priorita||'media','nuovo',req.session.userId,assegnato_a||null,now,now]);
  await dbInsert(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[id,req.session.userId,'creazione','Ticket creato',now]);

  // Email notifica nuovo ticket agli admin/operatori
  try {
    const admins = await dbQuery("SELECT email FROM users WHERE ruolo IN ('admin','operatore') AND attivo=1 AND email IS NOT NULL");
    const aperto_da = await dbQueryOne('SELECT nome,cognome FROM users WHERE id=?',[req.session.userId]);
    const nomeApertura = aperto_da ? aperto_da.nome+' '+aperto_da.cognome : 'Un dipendente';
    for (const adm of admins) {
      sendEmail(adm.email, `[HD] Nuovo ticket ${codice}: ${titolo}`, emailNuovoTicket({nome:'Team'}, {codice, titolo, area, priorita:priorita||'medium'}, nomeApertura));
    }
  } catch(e) { console.error('Email nuovo ticket error:', e.message); }

  if(assegnato_a){
    const op = await dbQueryOne('SELECT nome,cognome FROM users WHERE id=?',[assegnato_a]);
    if(op) await dbInsert(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[id,req.session.userId,'assegnazione',`Assegnato a ${op.nome} ${op.cognome}`,now]);
  }
  res.json({id,codice});
});

app.patch('/api/tickets/:id', auth, async (req,res) => {
  const {stato,assegnato_a,priorita,nota}=req.body;
  const t = await dbQueryOne('SELECT * FROM ticket WHERE id=?',[req.params.id]);
  if(!t) return res.status(404).json({error:'Non trovato'});
  const now=nowIT();
  if(stato&&stato!==t.stato){
    const risolto=['risolto','chiuso'].includes(stato)?now:t.risolto_il;
    await dbRun(`UPDATE ticket SET stato=?,aggiornato_il=?,risolto_il=? WHERE id=?`,[stato,now,risolto,req.params.id]);
    const statoLabels={nuovo:'NEW',aperto:'OPEN',in_lavorazione:'IN PROGRESS',risolto:'RESOLVED',chiuso:'CLOSED'};
    await dbInsert(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[req.params.id,req.session.userId,'stato',`Status: ${statoLabels[stato]||stato}`,now]);
    const tktOwner = await dbQueryOne('SELECT u.email,u.nome FROM users u JOIN ticket t ON t.aperto_da=u.id WHERE t.id=?',[req.params.id]);
    if (tktOwner && tktOwner.email && req.session.userId !== t.aperto_da) {
      const fullT = await dbQueryOne('SELECT codice,titolo FROM ticket WHERE id=?',[req.params.id]);
      sendEmail(tktOwner.email, `[HD] Ticket ${fullT.codice} — stato aggiornato: ${statoLabels[stato]||stato}`, emailStatoTicket(tktOwner, fullT, stato));
    }
  }
  if(assegnato_a!==undefined){
    await dbRun(`UPDATE ticket SET assegnato_a=?,aggiornato_il=? WHERE id=?`,[assegnato_a||null,now,req.params.id]);
    if(assegnato_a){
      const op = await dbQueryOne('SELECT nome,cognome FROM users WHERE id=?',[assegnato_a]);
      if(op) await dbInsert(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[req.params.id,req.session.userId,'assegnazione',`Assegnato a ${op.nome} ${op.cognome}`,now]);
    }
  }
  if(priorita&&priorita!==t.priorita){
    await dbRun(`UPDATE ticket SET priorita=?,aggiornato_il=? WHERE id=?`,[priorita,now,req.params.id]);
    await dbInsert(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[req.params.id,req.session.userId,'priorita',`Priorità: ${priorita}`,now]);
  }
  if(nota&&nota.trim()) {
    await dbInsert(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,[req.params.id,req.session.userId,'nota',nota.trim(),now]);
  }
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
  const now = nowIT();
  const inserted = [];
  for (const file of req.files) {
    let filename = file.filename || (Date.now() + '-' + file.originalname);
    let fileUrl = null;

    if (useCloudinary && file.buffer) {
      try {
        const result = await uploadToCloudinary(file.buffer, filename, file.mimetype);
        filename = result.public_id;
        fileUrl  = result.secure_url;
      } catch(e) {
        console.error('Cloudinary upload error:', e.message);
      }
    } else if (!useCloudinary && file.path) {
      fileUrl = `/uploads/${file.filename}`;
    }

    const fileSize = Number(file.size) || 0;
    const id = await dbInsert(
      `INSERT INTO allegati (ticket_id,utente_id,filename,originalname,size,mimetype,creato_il) VALUES (?,?,?,?,?,?,?)`,
      [ticketId, req.session.userId, fileUrl || filename, file.originalname, fileSize, file.mimetype, now]
    );
    await dbInsert(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,
      [ticketId, req.session.userId, 'allegato', `Allegato aggiunto: ${file.originalname}`, now]);
    inserted.push({ id, originalname: file.originalname, size: fileSize, url: fileUrl });
  }
  res.json({ ok: true, allegati: inserted });
});

app.get('/api/allegati/:id/download', auth, async (req, res) => {
  const a = await dbQueryOne('SELECT * FROM allegati WHERE id=?', [parseInt(req.params.id, 10)]);
  if (!a) return res.status(404).json({ error: 'Allegato non trovato' });
  if (a.filename && (a.filename.startsWith('http://') || a.filename.startsWith('https://'))) {
    return res.redirect(a.filename);
  }
  const filePath = path.join(uploadsDir, a.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File non trovato sul server' });

  // Per i video usa streaming con Range requests (necessario per progressbar e seeking)
  const videoExts = ['.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv'];
  const ext = path.extname(a.originalname).toLowerCase();
  if (videoExts.includes(ext)) {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      const file = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range':       `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges':       'bytes',
        'Content-Length':      chunkSize,
        'Content-Type':        a.mimetype || 'video/webm',
        'Content-Disposition': `inline; filename="${a.originalname}"`,
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length':      fileSize,
        'Content-Type':        a.mimetype || 'video/webm',
        'Accept-Ranges':       'bytes',
        'Content-Disposition': `inline; filename="${a.originalname}"`,
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } else {
    res.download(filePath, a.originalname);
  }
});

app.delete('/api/allegati/:id', auth, async (req, res) => {
  const a = await dbQueryOne('SELECT * FROM allegati WHERE id=?', [parseInt(req.params.id, 10)]);
  if (!a) return res.status(404).json({ error: 'Non trovato' });
  if (useCloudinary && a.filename && a.filename.includes('helpdesk/')) {
    try { await cloudinary.uploader.destroy(a.filename); } catch(e) {}
  } else {
    const filePath = path.join(uploadsDir, a.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  await dbRun('DELETE FROM allegati WHERE id=?', [parseInt(req.params.id, 10)]);
  const now = nowIT();
  await dbInsert(`INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)`,
    [a.ticket_id, req.session.userId, 'allegato', `Allegato rimosso: ${a.originalname}`, now]);
  res.json({ ok: true });
});

// ── Categorie ─────────────────────────────────────────────────────────────────
app.get('/api/categorie', auth, async (req,res) => res.json(await dbQuery('SELECT * FROM categorie WHERE attivo=1 ORDER BY tipo,nome')));
app.post('/api/categorie', admin, async (req,res) => {
  const{tipo,nome}=req.body;
  if(!tipo||!nome) return res.status(400).json({error:'Campi mancanti'});
  res.json({id: await dbInsert('INSERT INTO categorie (tipo,nome) VALUES (?,?)',[tipo,nome])});
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
    res.json({id: await dbInsert('INSERT INTO users (nome,cognome,email,password,ruolo,area) VALUES (?,?,?,?,?,?)',[nome,cognome,email.toLowerCase(),bcrypt.hashSync(password,10),ruolo||'dipendente',area||null])});
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
    aperti:     (await dbQueryOne(`SELECT COUNT(*) AS c FROM ticket WHERE stato NOT IN ('risolto','chiuso')`)).c,
    alta_prio:  (await dbQueryOne(`SELECT COUNT(*) AS c FROM ticket WHERE priorita IN ('high','critical') AND stato NOT IN ('risolto','chiuso')`)).c,
    oggi:       (await dbQueryOne(`SELECT COUNT(*) AS c FROM ticket WHERE stato IN ('risolto','chiuso') AND CAST(risolto_il AS DATE)=CAST(GETDATE() AS DATE)`)).c,
    nuovi_oggi: (await dbQueryOne(`SELECT COUNT(*) AS c FROM ticket WHERE CAST(creato_il AS DATE)=CAST(GETDATE() AS DATE)`)).c,
    per_area:   await dbQuery(`SELECT area,COUNT(*) AS c FROM ticket WHERE stato NOT IN ('risolto','chiuso') GROUP BY area ORDER BY c DESC`),
    per_stato:  await dbQuery(`SELECT stato,COUNT(*) AS c FROM ticket GROUP BY stato`)
  });
});

// ── Aree ─────────────────────────────────────────────────────────────────────
app.get('/api/aree', auth, async (req,res) => {
  res.json(await dbQuery('SELECT * FROM aree WHERE attivo=1 ORDER BY ordine,nome'));
});
app.post('/api/aree', admin, async (req,res) => {
  const {nome,ordine} = req.body;
  if(!nome) return res.status(400).json({error:'Nome obbligatorio'});
  try {
    const id = await dbInsert('INSERT INTO aree (nome,ordine) VALUES (?,?)',[nome.trim(),ordine||0]);
    res.json({id});
  } catch(e) { res.status(400).json({error:'Area già esistente'}); }
});
app.patch('/api/aree/:id', admin, async (req,res) => {
  const {nome,ordine} = req.body;
  await dbRun('UPDATE aree SET nome=?,ordine=? WHERE id=?',[nome,ordine||0,req.params.id]);
  res.json({ok:true});
});
app.delete('/api/aree/:id', admin, async (req,res) => {
  await dbRun('UPDATE aree SET attivo=0 WHERE id=?',[req.params.id]);
  res.json({ok:true});
});

// ── Annunci ───────────────────────────────────────────────────────────────────
app.get('/api/annunci', auth, async (req,res) => {
  // TOP 5 equivalent in T-SQL
  res.json(await dbQuery('SELECT TOP 5 * FROM annunci WHERE attivo=1 ORDER BY creato_il DESC'));
});
app.post('/api/annunci', admin, async (req,res) => {
  const {titolo,testo} = req.body;
  if(!titolo||!testo) return res.status(400).json({error:'Campi mancanti'});
  res.json({id: await dbInsert('INSERT INTO annunci (titolo,testo,creato_da) VALUES (?,?,?)',[titolo,testo,req.session.userId])});
});
app.delete('/api/annunci/:id', admin, async (req,res) => {
  await dbRun('UPDATE annunci SET attivo=0 WHERE id=?',[req.params.id]);
  res.json({ok:true});
});

// ── FAQ ───────────────────────────────────────────────────────────────────────
app.get('/api/faq', auth, async (req,res) => {
  res.json(await dbQuery('SELECT * FROM faq WHERE attivo=1 ORDER BY ordine,creato_il'));
});
app.post('/api/faq', admin, async (req,res) => {
  const {domanda,risposta,ordine} = req.body;
  if(!domanda||!risposta) return res.status(400).json({error:'Campi mancanti'});
  res.json({id: await dbInsert('INSERT INTO faq (domanda,risposta,ordine) VALUES (?,?,?)',[domanda,risposta,ordine||0])});
});
app.patch('/api/faq/:id', admin, async (req,res) => {
  const {domanda,risposta,ordine,attivo} = req.body;
  await dbRun('UPDATE faq SET domanda=?,risposta=?,ordine=?,attivo=? WHERE id=?',[domanda,risposta,ordine||0,attivo!==undefined?attivo:1,req.params.id]);
  res.json({ok:true});
});
app.delete('/api/faq/:id', admin, async (req,res) => {
  await dbRun('UPDATE faq SET attivo=0 WHERE id=?',[req.params.id]);
  res.json({ok:true});
});

// ── Feedback ──────────────────────────────────────────────────────────────────
app.get('/api/feedback/all', admin, async (req,res) => {
  const rows = await dbQuery(
    `SELECT f.*, t.codice, t.titolo, u.nome+' '+u.cognome AS utente_nome
     FROM feedback f
     JOIN ticket t ON t.id = f.ticket_id
     LEFT JOIN users u ON u.id = f.utente_id
     ORDER BY f.creato_il DESC`
  );
  res.json(rows);
});

app.get('/api/feedback/:ticketId', auth, async (req,res) => {
  const f = await dbQueryOne('SELECT * FROM feedback WHERE ticket_id=?',[req.params.ticketId]);
  res.json(f||null);
});

app.post('/api/feedback', auth, async (req,res) => {
  const {ticket_id,voto,commento} = req.body;
  if(!ticket_id||!voto) return res.status(400).json({error:'Campi mancanti'});
  const t = await dbQueryOne('SELECT id FROM ticket WHERE id=? AND aperto_da=?',[ticket_id,req.session.userId]);
  if(!t) return res.status(403).json({error:'Non autorizzato'});
  try {
    // MERGE replaces INSERT OR REPLACE for Azure SQL
    await pool.request()
      .input('ticket_id', ticket_id)
      .input('utente_id', req.session.userId)
      .input('voto', voto)
      .input('commento', commento||'')
      .query(`
        MERGE feedback AS target
        USING (SELECT @ticket_id AS ticket_id) AS source ON target.ticket_id = source.ticket_id
        WHEN MATCHED THEN
          UPDATE SET utente_id=@utente_id, voto=@voto, commento=@commento,
                     creato_il=FORMAT(GETDATE(),'yyyy-MM-dd HH:mm:ss')
        WHEN NOT MATCHED THEN
          INSERT (ticket_id,utente_id,voto,commento)
          VALUES (@ticket_id,@utente_id,@voto,@commento);
      `);
    const inserted = await dbQueryOne('SELECT id FROM feedback WHERE ticket_id=?',[ticket_id]);
    const id = inserted ? inserted.id : null;
    const now = nowIT();
    const stelle = '★'.repeat(voto) + '☆'.repeat(5-voto);
    await dbInsert('INSERT INTO attivita (ticket_id,utente_id,tipo,testo,creato_il) VALUES (?,?,?,?,?)',
      [ticket_id, req.session.userId, 'feedback', `Valutazione: ${stelle} (${voto}/5)`, now]);
    res.json({id});
  } catch(e) { res.status(400).json({error:e.message}); }
});

// ── Stats attività dipendente (ultimi 7 giorni) ───────────────────────────────
app.get('/api/attivita/settimana', auth, async (req,res) => {
  const userId = req.session.userId;
  const rows = await dbQuery(
    `SELECT CAST(creato_il AS DATE) AS giorno, COUNT(*) AS c
     FROM ticket WHERE aperto_da=?
     AND creato_il >= FORMAT(DATEADD(day,-6,GETDATE()),'yyyy-MM-dd')
     GROUP BY CAST(creato_il AS DATE)`,
    [userId]
  );
  res.json(rows);
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

initDB().then(()=>{
  app.listen(PORT,()=>console.log(`\n🚀 Help Desk → http://localhost:${PORT}\n   Admin: admin@helpdesk.it / admin123\n`));
}).catch(err=>{console.error('Errore DB:',err);process.exit(1);});
