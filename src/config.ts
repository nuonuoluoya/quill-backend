import { config as loadEnv } from 'dotenv';
import { projectPath } from './paths.js';
loadEnv({ path: projectPath('.env'), quiet: true });
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
export const production =
  process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';
const data = projectPath(process.env.DEV_DB_PATH || '.data/postgres');
function signingSecret() {
  if (process.env.MEDIA_SIGNING_SECRET && process.env.MEDIA_SIGNING_SECRET.length >= 32)
    return process.env.MEDIA_SIGNING_SECRET;
  if (production) throw new Error('MEDIA_SIGNING_SECRET must have at least 32 characters');
  const p = resolve(data, '..', 'development-signing-key');
  mkdirSync(resolve(p, '..'), { recursive: true });
  if (!existsSync(p)) writeFileSync(p, randomBytes(48).toString('hex'), { mode: 0o600 });
  return readFileSync(p, 'utf8');
}
export const config = {
  port: Number(process.env.PORT || 3210),
  host: process.env.HOST || '127.0.0.1',
  publicBase: process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:3210',
  databaseUrl: process.env.DATABASE_URL,
  devDbPath: data,
  mediaRoot: projectPath(process.env.MEDIA_ROOT || '.data/media'),
  secret: signingSecret(),
  appid: process.env.WECHAT_APP_ID || '',
  appSecret: process.env.WECHAT_APP_SECRET || '',
  corsOrigin: process.env.CORS_ORIGIN || 'http://127.0.0.1:5178',
  s3: {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'ap-shanghai',
    bucket: process.env.S3_BUCKET,
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  },
};
if (
  production &&
  (!config.databaseUrl ||
    !config.appid ||
    !config.appSecret ||
    !config.publicBase.startsWith('https://'))
)
  throw new Error('Production requires PostgreSQL, WeChat credentials and HTTPS PUBLIC_BASE_URL');
