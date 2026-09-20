import { z } from 'zod';
import { Database } from './db.js';
import { access, sha } from './auth.js';
import { readable } from './books.js';
import { Fault } from './errors.js';
import type { ProgressResult } from '../contracts/src/index.js';
const identity = z.string().min(1).max(512);
const base = {
  textRevision: identity,
  expectedVersion: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  clientMutationId: z.string().uuid(),
};
export const resetSchema = z.object(base).strict();
export const writeSchema = z
  .object({
    ...base,
    sourceBuildId: identity,
    chapterId: identity,
    sentenceId: identity,
    preferredSpeed: z.union([z.literal(0.75), z.literal(1), z.literal(1.25), z.literal(1.5)]),
  })
  .strict();
export class ProgressService {
  constructor(private db: Database) {}
  async get(user: string, bookId: string, textRevision: string): Promise<ProgressResult> {
    await access(this.db, bookId, user);
    const { rows } = await this.db.query(
      'SELECT version,progress FROM reading_progress WHERE user_id=$1 AND book_id=$2 AND text_revision=$3',
      [user, bookId, textRevision],
    );
    return rows[0]
      ? { version: Number(rows[0].version), progress: rows[0].progress }
      : { version: 0, progress: null };
  }
  async mutate(
    user: string,
    bookId: string,
    input: unknown,
    reset = false,
  ): Promise<ProgressResult> {
    const parsed = (reset ? resetSchema : writeSchema).safeParse(input);
    if (!parsed.success) throw new Fault(422, 'PROGRESS_INVALID', '进度字段或速度无效');
    const p = parsed.data,
      digest = sha(JSON.stringify({ operation: reset ? 'reset' : 'put', bookId, ...p }));
    return this.db.transaction(async (tx) => {
      await access(tx, bookId, user);
      // Account lock also serializes identical mutation IDs targeting different books.
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user]);
      const prior = await tx.query(
        'SELECT digest,response FROM progress_mutations WHERE user_id=$1 AND client_mutation_id=$2',
        [user, p.clientMutationId],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].digest !== digest)
          throw new Fault(409, 'IDEMPOTENCY_KEY_REUSED', '同一写入标识不能用于不同内容');
        return prior.rows[0].response;
      }
      if (reset) {
        const known = await tx.query(
          'SELECT 1 FROM book_builds WHERE book_id=$1 AND text_revision=$2 LIMIT 1',
          [bookId, p.textRevision],
        );
        if (!known.rows[0]) throw new Fault(422, 'PROGRESS_INVALID', '未知正文版本');
      } else {
        const w = writeSchema.parse(p);
        const { build } = await readable(tx, bookId, w.sourceBuildId, user);
        const s = await tx.query(
          'SELECT 1 FROM sentences WHERE book_id=$1 AND build_id=$2 AND chapter_id=$3 AND sentence_id=$4',
          [bookId, w.sourceBuildId, w.chapterId, w.sentenceId],
        );
        if (build.text_revision !== w.textRevision || !s.rows[0])
          throw new Fault(422, 'PROGRESS_INVALID', '正文版本或句子归属不匹配');
      }
      await tx.query(
        'INSERT INTO reading_progress(user_id,book_id,text_revision) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [user, bookId, p.textRevision],
      );
      const { rows } = await tx.query(
        'SELECT version,progress FROM reading_progress WHERE user_id=$1 AND book_id=$2 AND text_revision=$3 FOR UPDATE',
        [user, bookId, p.textRevision],
      );
      const version = Number(rows[0].version);
      if (version !== p.expectedVersion)
        throw new Fault(409, 'PROGRESS_CONFLICT', '另一台设备更新了阅读进度', {
          version,
          progress: rows[0].progress,
        });
      const updatedAt = new Date().toISOString();
      let progress = null;
      if (!reset) {
        const { expectedVersion, clientMutationId, ...fields } = writeSchema.parse(p);
        progress = { bookId, ...fields, updatedAt };
      }
      const response = { version: version + 1, progress };
      await tx.query(
        'UPDATE reading_progress SET version=$4,progress=$5,updated_at=$6 WHERE user_id=$1 AND book_id=$2 AND text_revision=$3',
        [user, bookId, p.textRevision, response.version, JSON.stringify(progress), updatedAt],
      );
      await tx.query(
        'INSERT INTO progress_mutations(user_id,client_mutation_id,digest,response) VALUES($1,$2,$3,$4)',
        [user, p.clientMutationId, digest, JSON.stringify(response)],
      );
      return response;
    });
  }
}
