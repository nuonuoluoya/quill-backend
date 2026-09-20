import { readFile, writeFile } from 'node:fs/promises';
import { Database } from './db.js';
import { exportSnapshot, importSnapshot, summary, type Snapshot } from './data-transfer.js';
const [operation, path] = process.argv.slice(2);
if (!['export','import','verify'].includes(operation) || !path) throw Error('Usage: transfer-cli export|import|verify FILE');
const db = new Database();
try {
  if (operation === 'export') {
    const snapshot = await exportSnapshot(db);
    await writeFile(path, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(summary(snapshot)));
  } else {
    const snapshot = JSON.parse(await readFile(path, 'utf8')) as Snapshot;
    if (operation === 'import') await importSnapshot(db, snapshot);
    const actual = await exportSnapshot(db);
    if (JSON.stringify(summary(snapshot)) !== JSON.stringify(summary(actual)) || JSON.stringify(snapshot.auditSequence) !== JSON.stringify(actual.auditSequence))
      throw Error('Transfer verification failed');
    console.log('All table counts, row digests and audit sequence match');
  }
} catch {
  // Database driver errors may include private row values. Do not log them.
  console.error('Data transfer failed; source and destination require operator review');
  process.exitCode = 1;
} finally { await db.close(); }
