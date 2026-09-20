import { createHmac, timingSafeEqual } from 'node:crypto';
import { Database, type Queryable } from './db.js';
import { access } from './auth.js';
import { Fault } from './errors.js';
import { config } from './config.js';
import type { Book, BookSummary, Chapter } from '../contracts/src/index.js';
export function sign(value: string) {
  return createHmac('sha256', config.secret).update(value).digest('base64url');
}
export function equal(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function readable(
  db: Queryable,
  bookId: string,
  buildId: string,
  user: string | null,
) {
  const book = await access(db, bookId, user);
  const { rows } = await db.query('SELECT * FROM book_builds WHERE book_id=$1 AND build_id=$2', [
    bookId,
    buildId,
  ]);
  const build = rows[0];
  if (!build || ['staged', 'ready'].includes(build.status))
    throw new Fault(404, 'BUILD_NOT_FOUND', '内容版本不存在');
  if (build.status === 'revoked') throw new Fault(410, 'BUILD_REVOKED', '此内容已下架');
  if (
    build.status === 'retired' ||
    (build.status === 'retained' && +new Date(build.retain_until) <= Date.now())
  )
    throw new Fault(410, 'BUILD_RETIRED', '此内容版本已到期，请更新');
  return { book, build };
}
export class BooksService {
  constructor(private db: Database) {}
  async list(user: string | null, audience: string, limit: number, cursor?: string) {
    if (audience === 'member' && !user)
      throw new Fault(401, 'SESSION_EXPIRED', '登录后查看我的书籍');
    let after = '';
    if (cursor) {
      try {
        const [body, signature, extra] = cursor.split('.');
        if (extra !== undefined || !signature || !equal(signature, sign(body))) throw Error();
        const c = JSON.parse(Buffer.from(body, 'base64url').toString());
        if (c.audience !== audience || c.user !== user || typeof c.after !== 'string')
          throw Error();
        after = c.after;
      } catch {
        throw new Fault(400, 'INVALID_REQUEST', '书架分页已失效，请刷新');
      }
    }
    const { rows } = await this.db.query(
      `SELECT b.visibility,v.metadata FROM books b JOIN book_builds v ON v.book_id=b.book_id AND v.build_id=b.active_build_id AND v.status='active'
      WHERE b.book_id>$1 AND (($2='sample' AND b.visibility='sample-public') OR ($2='member' AND b.visibility='private' AND EXISTS(SELECT 1 FROM book_access a WHERE a.book_id=b.book_id AND a.user_id=$3 AND a.revoked_at IS NULL AND a.starts_at<=now() AND (a.expires_at IS NULL OR a.expires_at>now())))) ORDER BY b.book_id LIMIT $4`,
      [after, audience, user, limit + 1],
    );
    const items: BookSummary[] = rows.slice(0, limit).map((r) => {
      const { chapters, ...book } = r.metadata as Book;
      return {
        ...book,
        visibility: r.visibility,
        chapterCount: chapters.length,
        contentChapterCount: chapters.filter((c) => c.sentenceCount > 0).length,
        sentenceCount: chapters.reduce((a, c) => a + c.sentenceCount, 0),
        playableCount: chapters.reduce((a, c) => a + c.playableCount, 0),
        chapterAudioAvailableCount: chapters.filter(
          (c) => c.sentenceCount > 0 && c.chapterAudioStatus === 'available',
        ).length,
      };
    });
    const body = Buffer.from(
      JSON.stringify({ user, audience, after: items.at(-1)?.bookId }),
    ).toString('base64url');
    return { items, nextCursor: rows.length > limit ? `${body}.${sign(body)}` : null };
  }
  async current(bookId: string, user: string | null) {
    const b = await access(this.db, bookId, user);
    if (!b.active_build_id) throw new Fault(503, 'CONTENT_UNAVAILABLE', '本书暂无可用内容');
    return this.snapshot(bookId, b.active_build_id, user);
  }
  async snapshot(bookId: string, buildId: string, user: string | null): Promise<Book> {
    const { build, book } = await readable(this.db, bookId, buildId, user);
    return { ...build.metadata, visibility: book.visibility };
  }
  async chapter(
    bookId: string,
    buildId: string,
    chapterId: string,
    user: string | null,
  ): Promise<Chapter> {
    await readable(this.db, bookId, buildId, user);
    const { rows } = await this.db.query(
      'SELECT content FROM chapters WHERE book_id=$1 AND build_id=$2 AND chapter_id=$3',
      [bookId, buildId, chapterId],
    );
    if (!rows[0]) throw new Fault(404, 'CHAPTER_NOT_FOUND', '章节不存在');
    return rows[0].content;
  }
  async playback(
    bookId: string,
    buildId: string,
    targetId: string,
    kind: 'sentence' | 'chapter',
    user: string | null,
  ) {
    return this.db.transaction(async (tx) => {
      const { build } = await readable(tx, bookId, buildId, user);
      // Serialize signing with publish/revoke so the latest issued deadline is never lost.
      const locked = await tx.query(
        'SELECT status,retain_until FROM book_builds WHERE book_id=$1 AND build_id=$2 FOR UPDATE',
        [bookId, buildId],
      );
      if (locked.rows[0].status !== build.status)
        throw new Fault(409, 'BUILD_UPDATE_REQUIRED', '内容状态已变化，请更新');
      const field = kind === 'chapter' ? 'chapter_id' : 'sentence_id';
      const { rows } = await tx.query(
        `SELECT * FROM audio_assets WHERE book_id=$1 AND build_id=$2 AND kind=$3 AND ${field}=$4`,
        [bookId, buildId, kind, targetId],
      );
      if (!rows[0]) {
        const table = kind === 'chapter' ? 'chapters' : 'sentences';
        const exists = await tx.query(
          `SELECT 1 FROM ${table} WHERE book_id=$1 AND build_id=$2 AND ${field}=$3`,
          [bookId, buildId, targetId],
        );
        if (!exists.rows[0])
          throw new Fault(
            404,
            kind === 'chapter' ? 'CHAPTER_NOT_FOUND' : 'SENTENCE_NOT_FOUND',
            '播放目标不存在',
          );
        throw new Fault(
          422,
          kind === 'chapter' ? 'CHAPTER_AUDIO_UNAVAILABLE' : 'SENTENCE_UNPLAYABLE',
          kind === 'chapter' ? '本章全文音频暂不可用' : '本句暂无可靠音频',
        );
      }
      const a = rows[0],
        now = Date.now(),
        duration = Number(a.duration);
      let until =
        now + Math.max(900, Math.ceil(duration / 0.75) + (kind === 'chapter' ? 600 : 60)) * 1000;
      if (build.status === 'retained') {
        const remain = +new Date(build.retain_until) - now;
        if (remain < (duration / 0.75 + 30) * 1000)
          throw new Fault(409, 'BUILD_UPDATE_REQUIRED', '旧内容即将到期，请更新后播放');
        until = Math.min(until, +new Date(build.retain_until));
      }
      const exp = Math.floor(until / 1000),
        signature = sign(`media:${a.audio_id}:${exp}`);
      await tx.query(
        'UPDATE book_builds SET last_signed_until=GREATEST(COALESCE(last_signed_until,$3::timestamptz),$3::timestamptz) WHERE book_id=$1 AND build_id=$2',
        [bookId, buildId, new Date(exp * 1000).toISOString()],
      );
      return {
        audioId: a.audio_id,
        url: `${config.publicBase}/media/${a.audio_id}?exp=${exp}&sig=${signature}`,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(exp * 1000).toISOString(),
        duration,
      };
    });
  }
}
