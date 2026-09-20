/** Isolated, real HTTP sample service; no credentials, fake login or production bypass. */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { Database } from './db.js';
import { Storage } from './storage.js';
import { ImportService } from './importer.js';
import { seedSamples } from './seed.js';
import { config, production } from './config.js';
if (production) throw Error('Mock service is disabled in production');
const db = new Database('', 'memory://'),
  storage = new Storage(await mkdtemp(resolve(tmpdir(), 'pidan-mock-')));
const { app } = await createApp(db, storage);
await seedSamples(db, new ImportService(db, storage));
await app.listen(config.port, '127.0.0.1');
console.log(
  `Isolated sample HTTP service on http://127.0.0.1:${config.port}; state is discarded at exit`,
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
