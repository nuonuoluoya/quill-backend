import { createHash } from 'node:crypto';
import type { Database, Queryable } from './db.js';

export const legacyTables = ['users', 'sessions', 'books', 'book_builds', 'chapters', 'sentences',
  'audio_assets', 'book_access', 'reading_progress', 'progress_mutations', 'content_audits'] as const;
export const favoriteTables = ['favorite_accounts','sentence_favorites','favorite_mutations'] as const;
export const tables = [...legacyTables,...favoriteTables] as const;
type Table = typeof tables[number];
type LegacyTable = typeof legacyTables[number];
export type Snapshot = {
  format: 'quill-transfer-v2';
  columns: Record<Table, string[]>;
  tables: Record<Table, Record<string, unknown>[]>;
  auditSequence: { last_value: string; is_called: boolean };
};
export type LegacySnapshot = {format:'quill-transfer-v1';columns:Record<LegacyTable,string[]>;tables:Record<LegacyTable,Record<string,unknown>[]>;auditSequence:Snapshot['auditSequence']};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function summary(snapshot: Snapshot | LegacySnapshot) {
  return Object.fromEntries((snapshot.format==='quill-transfer-v1'?legacyTables:tables).map(table => [table, {
    count: (snapshot.tables as Snapshot['tables'])[table].length,
    sha256: createHash('sha256').update((snapshot.tables as Snapshot['tables'])[table].map(canonical).sort().join('\n')).digest('hex'),
  }]));
}
async function columns(tx: Queryable, table: Table) {
  const { rows } = await tx.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table]);
  return rows.map(row => row.column_name);
}
export async function exportSnapshot(db: Database): Promise<Snapshot> {
  return db.transaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
    const snapshot: Snapshot = { format: 'quill-transfer-v2', columns: {} as Snapshot['columns'], tables: {} as Snapshot['tables'],
      auditSequence: (await tx.query<Snapshot['auditSequence']>('SELECT last_value::text,is_called FROM content_audits_id_seq')).rows[0] };
    for (const table of tables) {
      snapshot.columns[table] = await columns(tx, table);
      const expression = table === 'content_audits' ? "to_jsonb(t) || jsonb_build_object('id',id::text)" : 'to_jsonb(t)';
      (snapshot.tables as Snapshot['tables'])[table] = (await tx.query<{ row: Record<string, unknown> }>(`SELECT ${expression} AS row FROM ${table} t`)).rows.map(r => r.row);
    }
    return snapshot;
  });
}
export async function importSnapshot(db: Database, snapshot: Snapshot | LegacySnapshot) {
  const expectedTables = snapshot?.format === 'quill-transfer-v1' ? legacyTables : tables;
  if (!['quill-transfer-v1','quill-transfer-v2'].includes(snapshot?.format) || !snapshot.tables || !snapshot.columns ||
      Object.keys(snapshot.tables).sort().join() !== [...expectedTables].sort().join() ||
      Object.keys(snapshot.columns).sort().join() !== [...expectedTables].sort().join() ||
      !/^[1-9]\d*$/.test(snapshot.auditSequence?.last_value) || typeof snapshot.auditSequence?.is_called !== 'boolean')
    throw Error('Invalid transfer format');
  await db.transaction(async tx => {
    await tx.query(`LOCK TABLE ${tables.join(',')} IN ACCESS EXCLUSIVE MODE`);
    await tx.query('SET CONSTRAINTS ALL DEFERRED');
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
    const data = {...snapshot.tables} as Snapshot['tables'], schema = {...snapshot.columns} as Snapshot['columns'];
    for (const table of tables) {
      if ((await tx.query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length) throw Error('Target database must be empty');
      const expected = await columns(tx, table);
      if(snapshot.format==='quill-transfer-v1' && (favoriteTables as readonly string[]).includes(table)){data[table]=[];schema[table]=expected;}
      if (JSON.stringify(expected) !== JSON.stringify(schema[table]) || !Array.isArray(data[table]) ||
          data[table].some(row => !row || Array.isArray(row) || Object.keys(row).sort().join() !== [...expected].sort().join()))
        throw Error(`Transfer schema mismatch: ${table}`);
    }
    for (const table of tables) {
      const rows = data[table];
      for (let offset = 0; offset < rows.length; offset += 500)
        await tx.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`, [JSON.stringify(rows.slice(offset, offset + 500))]);
    }
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    for (const table of tables) {
      const expression = table === 'content_audits' ? "to_jsonb(t) || jsonb_build_object('id',id::text)" : 'to_jsonb(t)';
      const actual = (await tx.query<{row: Record<string, unknown>}>(`SELECT ${expression} AS row FROM ${table} t`)).rows.map(r => canonical(r.row)).sort();
      if (JSON.stringify(actual) !== JSON.stringify(data[table].map(canonical).sort()))
        throw Error(`Transfer content mismatch: ${table}`);
    }
    await tx.query("SELECT setval('content_audits_id_seq',$1::bigint,$2)", [snapshot.auditSequence.last_value, snapshot.auditSequence.is_called]);
  });
}

export function verifySnapshot(actual: Snapshot, expected: Snapshot | LegacySnapshot): boolean {
  const normalized = {...summary(expected)};
  if (expected.format === 'quill-transfer-v1') {
    for (const table of favoriteTables) normalized[table] = {count:0,sha256:createHash('sha256').update('').digest('hex')};
  }
  return canonical(summary(actual)) === canonical(normalized) && canonical(actual.auditSequence) === canonical(expected.auditSequence);
}