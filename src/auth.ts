import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Database, type Queryable } from './db.js';
import { Fault } from './errors.js';
import { config } from './config.js';
export const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export class AuthService {
  private accountBuckets = new Map<string, { until: number; count: number }>();
  constructor(private db: Database) {}
  async identity(header?: string) {
    if (!header) return null;
    if (!/^Bearer [A-Za-z0-9_-]{40,128}$/.test(header))
      throw new Fault(401, 'SESSION_EXPIRED', '请重新登录');
    const { rows } = await this.db.query(
      'SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND NOT u.disabled',
      [sha(header.slice(7))],
    );
    if (!rows[0]) throw new Fault(401, 'SESSION_EXPIRED', '登录已过期，请重新登录');
    const now = Date.now();
    for (const [key, value] of this.accountBuckets)
      if (value.until < now) this.accountBuckets.delete(key);
    const user = rows[0].user_id,
      bucket = this.accountBuckets.get(user) || { until: now + 60000, count: 0 };
    bucket.count++;
    this.accountBuckets.set(user, bucket);
    if (bucket.count > 600) throw new Fault(429, 'RATE_LIMITED', '账号请求过于频繁，请稍后重试');
    return rows[0].user_id as string;
  }
  async login(code: string) {
    if (!config.appid || !config.appSecret)
      throw new Fault(503, 'SERVICE_UNAVAILABLE', '微信登录尚未配置，请先体验样本');
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.search = new URLSearchParams({
      appid: config.appid,
      secret: config.appSecret,
      js_code: code,
      grant_type: 'authorization_code',
    }).toString();
    let data: any;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw Error();
      data = await r.json();
    } catch {
      throw new Fault(503, 'SERVICE_UNAVAILABLE', '微信登录服务暂不可用');
    }
    if (!data.openid || data.errcode)
      throw new Fault(400, 'LOGIN_CODE_INVALID', '登录凭证无效，请重新登录');
    return this.session(config.appid, data.openid);
  }
  /** Used by WeChat login and isolated tests/explicit local CLI, never a public mock-login endpoint. */
  async session(appid: string, openid: string) {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query(
        'INSERT INTO users(id,appid,openid) VALUES($1,$2,$3) ON CONFLICT(appid,openid) DO UPDATE SET appid=EXCLUDED.appid RETURNING id,disabled',
        [randomUUID(), appid, openid],
      );
      if (rows[0].disabled) throw new Fault(403, 'ACCOUNT_DISABLED', '该账号不可用');
      const accessToken = randomBytes(32).toString('base64url'),
        expiresAt = new Date(Date.now() + 7200000).toISOString();
      await tx.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [
        sha(accessToken),
        rows[0].id,
        expiresAt,
      ]);
      return { accessToken, expiresAt, user: { id: rows[0].id as string } };
    });
  }
  async logout(header: string) {
    await this.db.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [
      sha(header.slice(7)),
    ]);
    return { revoked: true };
  }
}
export function signedIn(user: string | null) {
  if (!user) throw new Fault(401, 'SESSION_EXPIRED', '请登录后使用云端进度');
  return user;
}
export async function access(db: Queryable, bookId: string, user: string | null) {
  const { rows } = await db.query('SELECT * FROM books WHERE book_id=$1', [bookId]);
  if (!rows[0]) throw new Fault(404, 'BOOK_NOT_FOUND', '书籍不存在');
  if (rows[0].visibility === 'private') {
    if (!user) throw new Fault(401, 'SESSION_EXPIRED', '请登录后访问本书');
    const a = await db.query(
      'SELECT 1 FROM book_access WHERE user_id=$1 AND book_id=$2 AND revoked_at IS NULL AND starts_at<=now() AND (expires_at IS NULL OR expires_at>now())',
      [user, bookId],
    );
    if (!a.rows[0]) throw new Fault(403, 'BOOK_FORBIDDEN', '尚未获得本书访问授权');
  }
  return rows[0];
}
