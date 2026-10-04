import { it, expect } from 'vitest';
import { mkdtemp, mkdir, cp, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectPath } from '../src/paths.js';

it('checks the actual OpenAPI CLI with both line endings and rejects real drift', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'quill-contract-check-'));
  for (const name of ['src', 'migrations', 'package.json', 'tsconfig.json'])
    await cp(projectPath(name), resolve(root, name), { recursive: true });
  await mkdir(resolve(root, 'contracts'));
  await cp(projectPath('contracts/src'), resolve(root, 'contracts/src'), { recursive: true });
  await symlink(projectPath('node_modules'), resolve(root, 'node_modules'), 'junction');
  const path = resolve(root, 'contracts/openapi.yaml');
  const baseline = (await readFile(projectPath('contracts/openapi.yaml'), 'utf8')).replace(/\r\n/g, '\n');
  const run = () => promisify(execFile)(process.execPath, [projectPath('node_modules/tsx/dist/cli.mjs'), resolve(root, 'src/openapi.ts'), '--check'], {
    cwd: root,
    timeout: 15000,
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: '', NEW_USER_BOOK_ID: '', S3_BUCKET: '',
      WECHAT_APP_ID: '', WECHAT_APP_SECRET: '', MEDIA_SIGNING_SECRET: 'isolated-contract-check-test-only-secret' },
  });
  for (const text of [baseline, baseline.replace(/\n/g, '\r\n')]) {
    await writeFile(path, text);
    expect((await run()).stdout).toContain('OpenAPI contract matches server');
  }
  const changed = JSON.parse(baseline);
  changed.components.schemas.Book.properties.bookId.type = 'number';
  for (const text of [JSON.stringify(changed, null, 2) + '\n', baseline + ' ', baseline.replace('\n', '\r')]) {
    await writeFile(path, text);
    await expect(run()).rejects.toThrow('OpenAPI is stale');
  }
}, 60000);
