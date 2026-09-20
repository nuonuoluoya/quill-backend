import { projectPath } from './paths.js';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { Ajv } from 'ajv';
import { parseBuffer } from 'music-metadata';
import { Database } from './db.js';
import { sha } from './auth.js';
import { Storage } from './storage.js';
import type { Book, Chapter, Visibility } from '../contracts/src/index.js';
const assert = (ok: unknown, message: string) => {
  if (!ok) throw Error(message);
};
export function safePath(value: unknown) {
  assert(typeof value === 'string' && value.length > 0, '资源路径为空');
  let p = value as string;
  for (let i = 0; i < 4 && p.includes('%'); i++) p = decodeURIComponent(p);
  assert(
    !/[\\:#?%\u0000-\u001f]/.test(p) &&
      !p.startsWith('/') &&
      p.split('/').every((s) => s && s !== '.' && s !== '..'),
    '资源路径越界或格式无效',
  );
  return p;
}
type FileInfo = { path: string; absolute: string; bytes: number; hash: string; duration?: number };
export interface ValidatedPackage {
  book: any;
  chapters: any[];
  files: Map<string, FileInfo>;
  digest: string;
  textDigest: string;
}
export async function validatePackage(directory: string): Promise<ValidatedPackage> {
  const root = await realpath(directory),
    files = new Map<string, FileInfo>();
  async function load(p: string, mp3 = false) {
    p = safePath(p);
    if (files.has(p)) return files.get(p)!;
    const absolute = await realpath(resolve(root, ...p.split('/'))),
      rel = relative(root, absolute);
    assert(!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel), '符号链接越界');
    const info = await stat(absolute);
    assert(
      info.isFile() && info.size > 0 && info.size < 256 * 1024 * 1024,
      '文件为空或超过 256 MiB 上限',
    );
    const buffer = await readFile(absolute);
    const f: FileInfo = { path: p, absolute, bytes: buffer.length, hash: sha(buffer) };
    if (mp3) {
      assert(p.toLowerCase().endsWith('.mp3'), '音频必须为 MP3');
      const meta = await parseBuffer(buffer, { mimeType: 'audio/mpeg' }, { duration: true });
      assert(
        meta.format.container === 'MPEG' &&
          Number.isFinite(meta.format.duration) &&
          meta.format.duration! > 0,
        '无效 MP3',
      );
      f.duration = meta.format.duration;
    }
    files.set(p, f);
    return f;
  }
  const ajv = new Ajv({ allErrors: true, strict: true });
  const bookSchema = JSON.parse(
    await readFile(projectPath('contracts/schemas/book-v2.schema.json'), 'utf8'),
  );
  const chapterSchema = JSON.parse(
    await readFile(projectPath('contracts/schemas/chapter-v2.schema.json'), 'utf8'),
  );
  const vb = ajv.compile(bookSchema),
    vc = ajv.compile(chapterSchema);
  const va = ajv.compile(
    JSON.parse(await readFile(projectPath('contracts/schemas/chapter-audio.schema.json'), 'utf8')),
  );
  const rootFile = await load('book.json'),
    book = JSON.parse(await readFile(rootFile.absolute, 'utf8'));
  assert(vb(book), `书籍 Schema 无效：${ajv.errorsText(vb.errors)}`);
  assert(book.buildId.length <= 512 && book.textRevision.length <= 512, '版本标识超过 512 字符');
  const ids = new Set<string>(),
    chapterIds = new Set<string>(),
    chapterPaths = new Set<string>(),
    chapters: any[] = [];
  for (const e of book.chapters) {
    assert(!chapterIds.has(e.id), '章节 ID 重复');
    chapterIds.add(e.id);
    const p = safePath(e.data);
    assert(!chapterPaths.has(p), '章节路径重复');
    chapterPaths.add(p);
    const f = await load(p),
      c = JSON.parse(await readFile(f.absolute, 'utf8'));
    assert(vc(c), `章节 Schema 无效：${ajv.errorsText(vc.errors)}`);
    assert(
      c.bookId === book.book.id &&
        c.buildId === book.buildId &&
        c.textRevision === book.textRevision &&
        c.chapterId === e.id,
      '章节快照身份不一致',
    );
    assert(
      Math.abs(c.chapterDuration - e.duration) <= 0.1 && c.sentences.length === e.sentenceCount,
      '章节计数或时长不一致',
    );
    let playable = 0;
    for (const [i, s] of c.sentences.entries()) {
      assert(!ids.has(s.id) && s.index === i + 1, '句子重复或序号不连续');
      ids.add(s.id);
      const can = ['verified', 'auto_passed'].includes(s.alignment.status);
      if (can) {
        assert(
          typeof s.audio === 'string' && Number.isFinite(s.duration) && s.duration > 0,
          '可播放句缺少音频',
        );
        const a = await load(s.audio, true);
        assert(Math.abs(a.duration! - s.duration) <= 0.1, `句子 ${s.id} 实际时长不符`);
        playable++;
      } else
        assert(
          s.audio === null &&
            s.duration === null &&
            s.alignment.reasons.some((r: string) => r.trim()),
          '不可播放句音频/原因冲突',
        );
      if (s.timing) {
        const t = s.timing;
        assert(
          !s.sourceTiming &&
            !s.padding &&
            0 <= t.clipStart &&
            t.clipStart <= t.speechStart &&
            t.speechStart < t.speechEnd &&
            t.speechEnd <= t.clipEnd &&
            t.clipEnd <= c.chapterDuration,
          'timing 边界无效',
        );
        assert(
          t.leadingPad <= 0.5 &&
            t.trailingPad <= 0.5 &&
            Math.abs(t.leadingPad - (t.speechStart - t.clipStart)) < 0.001 &&
            Math.abs(t.trailingPad - (t.clipEnd - t.speechEnd)) < 0.001,
          'timing 缓冲无效',
        );
        if (can) assert(Math.abs(s.duration - (t.clipEnd - t.clipStart)) <= 0.1, '片段时长不符');
      }
      if (s.sourceTiming || s.padding) {
        const t = s.sourceTiming,
          p = s.padding;
        assert(
          t && p && !s.timing && t.start < t.end && t.end <= c.chapterDuration + 0.001,
          '补白字段或源时间无效',
        );
        if (can)
          assert(
            Math.abs(s.duration - (t.end - t.start + p.leadingSilence + p.trailingSilence)) <= 0.1,
            '补白时长不符',
          );
      }
    }
    assert(playable === e.playableCount, '可播放数量错误');
    if ('chapterAudio' in c) {
      const a = c.chapterAudio;
      assert(va(a), '整章扩展格式错误');
      if (a.status === 'available') {
        assert(
          typeof a.audio === 'string' &&
            Number.isFinite(a.duration) &&
            a.duration > 0 &&
            a.reasons.length === 0,
          '整章可用状态错误',
        );
        const f = await load(a.audio, true);
        assert(
          Math.abs(a.duration - c.chapterDuration) <= 0.1 &&
            Math.abs(f.duration! - c.chapterDuration) <= 0.1,
          '整章时长不符',
        );
      } else
        assert(
          a.audio === null && a.duration === null && a.reasons.length > 0,
          '整章不可用原因缺失',
        );
    }
    chapters.push(c);
  }
  assert(
    [...files.values()].reduce((n, f) => n + f.bytes, 0) <= 10 * 1024 ** 3,
    '包超过 10 GiB 上限',
  );
  // Re-reading metadata must not permit a file change between its hash and parsed content.
  for (const f of files.values())
    assert(sha(await readFile(f.absolute)) === f.hash, '校验期间文件被修改');
  const manifest = [...files.values()]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((f) => [f.path, f.bytes, f.hash]);
  const textDigest = sha(
    JSON.stringify(
      chapters.map((c) => [c.chapterId, c.sentences.map((s: any) => [s.id, s.index, s.text])]),
    ),
  );
  return { book, chapters, files, digest: sha(JSON.stringify(manifest)), textDigest };
}
export class ImportService {
  constructor(
    private db: Database,
    private storage: Storage,
  ) {}
  async import(directory: string, visibility: Visibility, actor: string) {
    const p = await validatePackage(directory),
      b = p.book,
      id = b.book.id,
      build = b.buildId;
    const prior = await this.db.query(
      'SELECT digest,status FROM book_builds WHERE book_id=$1 AND build_id=$2',
      [id, build],
    );
    if (prior.rows[0]) {
      assert(prior.rows[0].digest === p.digest, '相同 buildId 不同包，拒绝覆盖');
      if (prior.rows[0].status !== 'staged')
        return { bookId: id, buildId: build, status: prior.rows[0].status, reused: true };
    }
    await this.db.transaction(async (tx) => {
      await tx.query('INSERT INTO books(book_id,visibility) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        id,
        visibility,
      ]);
      const old = await tx.query('SELECT visibility FROM books WHERE book_id=$1 FOR UPDATE', [id]);
      assert(old.rows[0].visibility === visibility, '书籍可见性不可修改');
      const revisions = await tx.query(
        'SELECT text_digest FROM book_builds WHERE book_id=$1 AND text_revision=$2',
        [id, b.textRevision],
      );
      assert(
        revisions.rows.every((r) => r.text_digest === p.textDigest),
        '同正文版本的身份/顺序/文本发生变化',
      );
      await tx.query(
        "INSERT INTO book_builds(book_id,build_id,text_revision,digest,text_digest,status,metadata) VALUES($1,$2,$3,$4,$5,'staged','{}') ON CONFLICT DO NOTHING",
        [id, build, b.textRevision, p.digest, p.textDigest],
      );
      const staged = await tx.query(
        'SELECT digest FROM book_builds WHERE book_id=$1 AND build_id=$2',
        [id, build],
      );
      assert(staged.rows[0].digest === p.digest, '并发导入包不一致，禁止上传');
    });
    const assets: any[] = [];
    const chapterDtos: Chapter[] = [];
    const makeAudio = (c: any, s: any | null, a: any) => {
      const audioId = sha(JSON.stringify([id, build, c.chapterId, s?.id ?? null]));
      const f = p.files.get(safePath(a.audio))!;
      const objectKey = `${sha(id)}/${sha(build)}/${audioId}.mp3`;
      assets.push({
        audioId,
        chapterId: c.chapterId,
        sentenceId: s?.id ?? null,
        kind: s ? 'sentence' : 'chapter',
        objectKey,
        f,
        duration: a.duration,
      });
      return audioId;
    };
    for (const c of p.chapters) {
      const ca = c.chapterAudio;
      chapterDtos.push({
        bookId: id,
        buildId: build,
        textRevision: b.textRevision,
        chapterId: c.chapterId,
        chapterDuration: c.chapterDuration,
        chapterAudio:
          ca?.status === 'available'
            ? {
                status: 'available',
                audioId: makeAudio(c, null, ca),
                duration: ca.duration,
                reasons: [],
              }
            : {
                status: 'unavailable',
                audioId: null,
                duration: null,
                reasons: ca?.reasons || ['本章全文音频暂不可用'],
              },
        sentences: c.sentences.map((s: any) => ({
          id: s.id,
          index: s.index,
          text: s.text,
          ...(s.sourceText ? { sourceText: s.sourceText } : {}),
          duration: s.duration,
          alignment: { status: s.alignment.status, reasons: s.alignment.reasons },
          audioId: s.audio ? makeAudio(c, s, s) : null,
        })),
      });
    }
    for (const a of assets) {
      const data = await readFile(a.f.absolute);
      assert(sha(data) === a.f.hash, '校验后文件被修改');
      await this.storage.put(a.objectKey, data, a.f.hash);
    }
    const dto: Book = {
      bookId: id,
      buildId: build,
      textRevision: b.textRevision,
      title: b.book.title,
      language: b.book.language,
      edition: b.book.edition,
      contentScope: b.contentScope,
      visibility,
      chapters: b.chapters.map((e: any, i: number) => ({
        id: e.id,
        title: e.title,
        sentenceCount: e.sentenceCount,
        playableCount: e.playableCount,
        duration: e.duration,
        chapterAudioStatus: chapterDtos[i].chapterAudio.status,
      })),
    };
    await this.db.transaction(async (tx) => {
      const lock = await tx.query(
        'SELECT digest,status FROM book_builds WHERE book_id=$1 AND build_id=$2 FOR UPDATE',
        [id, build],
      );
      assert(lock.rows[0].digest === p.digest, '并发导入包不一致');
      if (lock.rows[0].status !== 'staged') return;
      for (const [i, c] of chapterDtos.entries()) {
        await tx.query(
          'INSERT INTO chapters(book_id,build_id,chapter_id,sort_order,entry,content) VALUES($1,$2,$3,$4,$5,$6)',
          [id, build, c.chapterId, i, JSON.stringify(dto.chapters[i]), JSON.stringify(c)],
        );
        for (const s of c.sentences)
          await tx.query(
            'INSERT INTO sentences(book_id,build_id,chapter_id,sentence_id,sentence_index,content) VALUES($1,$2,$3,$4,$5,$6)',
            [id, build, c.chapterId, s.id, s.index, JSON.stringify(s)],
          );
      }
      for (const a of assets)
        await tx.query(
          'INSERT INTO audio_assets(audio_id,book_id,build_id,chapter_id,kind,sentence_id,object_key,bytes,hash,duration) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            a.audioId,
            id,
            build,
            a.chapterId,
            a.kind,
            a.sentenceId,
            a.objectKey,
            a.f.bytes,
            a.f.hash,
            a.duration,
          ],
        );
      await tx.query(
        "UPDATE book_builds SET status='ready',metadata=$3 WHERE book_id=$1 AND build_id=$2",
        [id, build, JSON.stringify(dto)],
      );
      await tx.query(
        "INSERT INTO content_audits(actor,action,book_id,build_id,details) VALUES($1,'import',$2,$3,$4)",
        [actor, id, build, JSON.stringify({ digest: p.digest, files: p.files.size })],
      );
    });
    return { bookId: id, buildId: build, status: 'ready', files: p.files.size };
  }
  async publish(bookId: string, buildId: string, expected: string | null, actor: string) {
    const assets = await this.db.query(
      'SELECT object_key,bytes FROM audio_assets WHERE book_id=$1 AND build_id=$2',
      [bookId, buildId],
    );
    for (const a of assets.rows)
      assert(
        (await this.storage.size(a.object_key)) === Number(a.bytes),
        '对象缺失或长度错误，禁止发布',
      );
    await this.db.transaction(async (tx) => {
      const b = (await tx.query('SELECT * FROM books WHERE book_id=$1 FOR UPDATE', [bookId]))
        .rows[0];
      assert(b, '书籍不存在');
      assert(b.active_build_id === expected, '活动构建已改变，请重新核对');
      if (expected === buildId) return;
      const v = (
        await tx.query('SELECT * FROM book_builds WHERE book_id=$1 AND build_id=$2 FOR UPDATE', [
          bookId,
          buildId,
        ])
      ).rows[0];
      assert(
        v &&
          (v.status === 'ready' ||
            (v.status === 'retained' && +new Date(v.retain_until) > Date.now())),
        '目标构建不可发布或回退',
      );
      if (expected)
        await tx.query(
          "UPDATE book_builds SET status='retained',retain_until=now()+interval '7 days' WHERE book_id=$1 AND build_id=$2",
          [bookId, expected],
        );
      await tx.query(
        "UPDATE book_builds SET status='active',published_at=now(),retain_until=NULL WHERE book_id=$1 AND build_id=$2",
        [bookId, buildId],
      );
      await tx.query('UPDATE books SET active_build_id=$2 WHERE book_id=$1', [bookId, buildId]);
      await tx.query(
        "INSERT INTO content_audits(actor,action,book_id,build_id) VALUES($1,'publish',$2,$3)",
        [actor, bookId, buildId],
      );
    });
  }
  async revoke(bookId: string, buildId: string, actor: string) {
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT book_id FROM books WHERE book_id=$1 FOR UPDATE', [bookId]);
      await tx.query("UPDATE book_builds SET status='revoked' WHERE book_id=$1 AND build_id=$2", [
        bookId,
        buildId,
      ]);
      await tx.query(
        'UPDATE books SET active_build_id=NULL WHERE book_id=$1 AND active_build_id=$2',
        [bookId, buildId],
      );
      await tx.query(
        "INSERT INTO content_audits(actor,action,book_id,build_id) VALUES($1,'revoke-build',$2,$3)",
        [actor, bookId, buildId],
      );
    });
  }
}
