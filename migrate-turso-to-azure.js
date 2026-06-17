#!/usr/bin/env node
require('dotenv').config();
const { createClient } = require('@libsql/client');
const sql = require('mssql');
const tursoClient = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const azureSqlConfig = {
  server: process.env.AZURE_SQL_SERVER,
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
let azurePool;
async function queryTurso(query) {
  const result = await tursoClient.execute(query);
  return result.rows.map(row => {
    const obj = {};
    result.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}
async function migrate() {
  console.log('\n🔄 INIZIO MIGRAZIONE: Turso → Azure SQL\n');
  try {
    console.log('Connessione a Azure SQL...');
    azurePool = new sql.ConnectionPool(azureSqlConfig);
    await azurePool.connect();
    console.log('✓ Connesso ad Azure SQL\n');
    const tables = ['users','categorie','aree','ticket','attivita','allegati','annunci','faq','feedback'];
    for (const table of tables) {
      console.log(`📋 Migrazione: [${table}]...`);
      const rows = await queryTurso(`SELECT * FROM ${table}`);
      if (rows.length === 0) {
        console.log(`   ✓ Vuota (0 righe)\n`);
        continue;
      }
      let success = 0;
      for (const row of rows) {
        const req = azurePool.request();
        const cols = Object.keys(row);
        let paramIdx = 0;
        cols.forEach(col => req.input(`p${paramIdx++}`, row[col]));
        const colNames = cols.map(c => `[${c}]`).join(',');
        const placeholders = cols.map((_, i) => `@p${i}`).join(',');
        const ins = `INSERT INTO [dbo].[${table}] (${colNames}) VALUES (${placeholders})`;
        try {
          await req.query(ins);
          success++;
        } catch (e) {
          console.error(`   ⚠ Errore su riga ${row.id || row.ticket_id}: ${e.message}`);
        }
      }
      console.log(`   ✓ ${success}/${rows.length} righe inserite\n`);
    }
    console.log('\n📊 Verifica conteggi post-migrazione:\n');
    for (const table of tables) {
      const result = await azurePool.request().query(`SELECT COUNT(*) as cnt FROM [dbo].[${table}]`);
      const count = result.recordset[0].cnt;
      const tursoCount = (await queryTurso(`SELECT COUNT(*) as cnt FROM ${table}`))[0].cnt;
      const match = count === tursoCount ? '✓' : '⚠';
      console.log(`${match} [${table}] Azure SQL: ${count} | Turso: ${tursoCount}`);
    }
    console.log('\n✓ MIGRAZIONE COMPLETATA\n');
  } catch (err) {
    console.error('\n❌ ERRORE DURANTE LA MIGRAZIONE:\n', err.message);
    process.exit(1);
  } finally {
    if (azurePool) {
      await azurePool.close();
    }
  }
}
migrate();
