import { Database } from './db.js';
import { ImportService, validatePackage } from './importer.js';
import { Storage } from './storage.js';
import { AuthService } from './auth.js';
import { production } from './config.js';
import { seedSamples } from './seed.js';
const [command, ...args] = process.argv.slice(2),
  actor = process.env.OPERATOR_ID || 'local-operator';
const db = new Database(),
  ops = new ImportService(db, new Storage());
try {
  await db.migrate();
  if (command === 'validate') {
    const p = await validatePackage(args[0]);
    console.log({
      bookId: p.book.book.id,
      buildId: p.book.buildId,
      files: p.files.size,
      digest: p.digest,
    });
  } else if (command === 'import') {
    if (!['private', 'sample-public'].includes(args[1]))
      throw Error(
        'Specify private or sample-public; only import content you are authorized to host',
      );
    console.log(await ops.import(args[0], args[1] as any, actor));
  } else if (command === 'publish' || command === 'rollback') {
    if (args.length < 3)
      throw Error('Usage: publish BOOK BUILD EXPECTED_ACTIVE (use none for first publish)');
    await ops.publish(args[0], args[1], args[2] === 'none' ? null : args[2], actor);
    console.log('Published', args[0], args[1]);
  } else if (command === 'revoke-build') {
    await ops.revoke(args[0], args[1], actor);
    console.log('Build revoked');
  } else if (command === 'grant' || command === 'revoke-access') {
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO book_access(user_id,book_id,revoked_at) VALUES($1,$2,${command === 'grant' ? 'NULL' : 'now()'}) ON CONFLICT(user_id,book_id) DO UPDATE SET revoked_at=EXCLUDED.revoked_at`,
        [args[0], args[1]],
      );
      await tx.query(
        'INSERT INTO content_audits(actor,action,book_id,details) VALUES($1,$2,$3,$4)',
        [actor, command, args[1], JSON.stringify({ userId: args[0] })],
      );
    });
    console.log('Access updated');
  } else if (command === 'seed') {
    if (production)
      throw Error(
        'Local sample seed is development-only; use reviewed import/publish in production',
      );
    await seedSamples(db, ops);
    console.log('Original audio samples are ready');
  } else if (command === 'dev-session') {
    if (production) throw Error('Development sessions are disabled in production');
    if (!args[0]) throw Error('Name required');
    console.log(await new AuthService(db).session('local-development', args[0]));
  } else if (command === 'maintenance') {
    await db.query(
      "UPDATE book_builds SET status='retired' WHERE status='retained' AND retain_until<=now()",
    );
    await db.query("DELETE FROM progress_mutations WHERE created_at<now()-interval '30 days'");
    await db.query("DELETE FROM sessions WHERE expires_at<now()-interval '7 days'");
    console.log(
      'Retention states and expired session/mutation records updated; no media objects deleted',
    );
  } else
    throw Error(
      'Commands: validate PATH | import PATH private|sample-public | publish/rollback BOOK BUILD EXPECTED | grant/revoke-access USER BOOK | revoke-build BOOK BUILD | seed | dev-session NAME | maintenance',
    );
} catch (e) {
  console.error(e instanceof Error ? e.message : 'Operation failed');
  process.exitCode = 1;
} finally {
  await db.close();
}
