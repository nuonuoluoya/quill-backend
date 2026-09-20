import { projectPath } from './paths.js';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { config } from './config.js';
export interface Queryable {
  query<T = Record<string, any>>(sql: string, args?: any[]): Promise<{ rows: T[] }>;
}
export class Database implements Queryable {
  private pool?: pg.Pool;
  private local?: PGlite;
  constructor(url = config.databaseUrl, localPath = config.devDbPath) {
    if (url)
      this.pool = new pg.Pool({
        connectionString: url,
        max: 10,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
      });
    else this.local = new PGlite(localPath);
  }
  async query<T = Record<string, any>>(sql: string, args: any[] = []): Promise<{ rows: T[] }> {
    if (this.pool) return (await this.pool.query(sql, args)) as unknown as { rows: T[] };
    return this.local!.query<T>(sql, args);
  }
  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    if (this.local) return this.local.transaction((tx) => work(tx as Queryable));
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async migrate() {
    const sql = await readFile(
      projectPath('migrations/001-initial.sql'),
      'utf8',
    );
    if (this.local) await this.local.exec(sql);
    else await this.pool!.query(sql);
  }
  async close() {
    await this.pool?.end();
    await this.local?.close();
  }
}
