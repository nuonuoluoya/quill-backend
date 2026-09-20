import { projectPath } from './paths.js';
import { readFile, writeFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { Database } from './db.js';
const db = new Database('', 'memory://');
const { app, document } = await createApp(db);
try {
  // JSON is valid YAML 1.2; a deterministic representation needs no YAML runtime dependency.
  const output = JSON.stringify(document, null, 2) + '\n',
    path = projectPath('contracts/openapi.yaml');
  if (process.argv.includes('--check')) {
    if ((await readFile(path, 'utf8')) !== output)
      throw Error('OpenAPI is stale. Run npm run openapi.');
    console.log('OpenAPI contract matches server');
  } else {
    await writeFile(path, output);
    console.log('Wrote contracts/openapi.yaml');
  }
} finally {
  await app.close();
  await db.close();
}
