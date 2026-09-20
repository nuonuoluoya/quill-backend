import { projectPath } from '../src/paths.js';
import { readFile, writeFile } from 'node:fs/promises';
for (const name of ['book-v2.schema.json', 'chapter-v2.schema.json']) {
  const upstream = projectPath('schemas', name),
    snapshot = projectPath('contracts/schemas', name);
  let source: string;
  try {
    source = await readFile(upstream, 'utf8');
  } catch {
    throw Error(
      `Upstream schema missing: ${upstream}; restore the schemas directory in this backend project`,
    );
  }
  if (process.argv.includes('--update')) await writeFile(snapshot, source);
  else if ((await readFile(snapshot, 'utf8')) !== source)
    throw Error(`Schema snapshot drift: ${name}`);
}
console.log('v2 schema snapshots match upstream; chapterAudio and content metadata extensions are maintained separately');
