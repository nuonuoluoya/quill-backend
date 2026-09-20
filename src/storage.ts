import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { config } from './config.js';
import { sha } from './auth.js';
export class Storage {
  private s3 = config.s3.bucket
    ? new S3Client({
        endpoint: config.s3.endpoint,
        region: config.s3.region,
        forcePathStyle: true,
        credentials: {
          accessKeyId: config.s3.accessKeyId,
          secretAccessKey: config.s3.secretAccessKey,
        },
      })
    : null;
  constructor(private root = config.mediaRoot) {}
  private path(key: string) {
    if (!/^[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}\.mp3$/.test(key))
      throw Error('Invalid internal object key');
    const p = resolve(this.root, key);
    if (!p.startsWith(resolve(this.root) + sep)) throw Error('Object path escaped');
    return p;
  }
  async put(key: string, data: Buffer, hash: string) {
    if (sha(data) !== hash) throw Error('Upload hash changed');
    if (this.s3) {
      try {
        await this.s3.send(
          new PutObjectCommand({
            Bucket: config.s3.bucket,
            Key: key,
            Body: data,
            ContentType: 'audio/mpeg',
            Metadata: { sha256: hash },
            IfNoneMatch: '*',
          }),
        );
      } catch (e: any) {
        if (e?.$metadata?.httpStatusCode !== 412) throw e;
        const old = await this.s3.send(
          new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key }),
        );
        if (old.Metadata?.sha256 !== hash || old.ContentLength !== data.length)
          throw Error('Immutable object hash differs');
      }
    } else {
      const p = this.path(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data, { flag: 'wx' }).catch(async (e) => {
        if (e.code !== 'EEXIST' || sha(await readFile(p)) !== hash) throw e;
      });
    }
    const size = await this.size(key);
    if (size !== data.length) throw Error('Uploaded object length differs');
  }
  async size(key: string) {
    if (this.s3) {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key }));
      return r.ContentLength;
    }
    return (await stat(this.path(key))).size;
  }
  async stream(key: string, range?: { start: number; end: number }) {
    if (this.s3) {
      const r = await this.s3.send(
        new GetObjectCommand({
          Bucket: config.s3.bucket,
          Key: key,
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        }),
      );
      return r.Body as Readable;
    }
    return createReadStream(this.path(key), range);
  }
}
export function byteRange(
  header: string | undefined,
  size: number,
): { status: 200 | 206 | 400 | 416; start?: number; end?: number } {
  if (!header || !header.startsWith('bytes=') || header.includes(',')) return { status: 200 };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return { status: 400 };
  let start: number, end: number;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0) return { status: 416 };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Number(m[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (m[2] && end < start))
      return { status: 400 };
    if (start >= size) return { status: 416 };
    end = Math.min(end, size - 1);
  }
  if (start >= size || size === 0) return { status: 416 };
  return { status: 206, start, end };
}
