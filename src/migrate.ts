import { Database } from './db.js';
const db = new Database();
try { await db.migrate(); console.log('Database schema migration completed'); }
catch { console.error('Database schema migration failed'); process.exitCode = 1; }
finally { await db.close(); }
