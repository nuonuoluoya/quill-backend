import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Source lives in src/; compiled modules live in dist/src/.
export const projectRoot = existsSync(resolve(here, '../package.json'))
  ? resolve(here, '..')
  : resolve(here, '../..');
if (!existsSync(resolve(projectRoot, 'package.json')))
  throw new Error(`Backend project root not found: ${projectRoot}`);

export const projectPath = (...parts: string[]) => resolve(projectRoot, ...parts);
