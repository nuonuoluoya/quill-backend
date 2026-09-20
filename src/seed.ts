import { projectPath } from './paths.js';
import type { Database } from './db.js';
import type { ImportService } from './importer.js';
export async function seedSamples(db: Database, ops: ImportService) {
  for (const id of ['a-quiet-morning', 'the-lantern-garden']) {
    const r = await ops.import(
      projectPath('contracts/fixtures', id),
      'sample-public',
      'sample-seed',
    );
    const active = (await db.query('SELECT active_build_id FROM books WHERE book_id=$1', [id]))
      .rows[0].active_build_id;
    await ops.publish(id, r.buildId, active, 'sample-seed');
  }
}
