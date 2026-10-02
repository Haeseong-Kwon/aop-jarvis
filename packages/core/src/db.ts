// SQLite access behind a two-method driver so the same repositories run on
// tauri-plugin-sql in the app and node:sqlite in tests. Params use `?` placeholders.

export type SqlValue = string | number | null
export interface SqlDriver {
  execute(sql: string, params?: SqlValue[]): Promise<void>
  select<T>(sql: string, params?: SqlValue[]): Promise<T[]>
}

/** Append-only. Never edit a shipped migration; add a new one. */
export const MIGRATIONS: string[] = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

   CREATE TABLE sources (
     id TEXT PRIMARY KEY, type TEXT NOT NULL, uri TEXT, title TEXT NOT NULL,
     content TEXT NOT NULL, created_at INTEGER NOT NULL);

   CREATE TABLE memories (
     id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
     entities TEXT NOT NULL DEFAULT '[]', project TEXT, importance REAL NOT NULL DEFAULT 0.5,
     confidence REAL NOT NULL DEFAULT 0.8, source_id TEXT REFERENCES sources(id),
     source_type TEXT, embedding TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     last_accessed_at INTEGER);
   CREATE INDEX memories_project ON memories(project, type);

   CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, title, content, entities, project);

   CREATE TABLE relations (
     id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL,
     created_at INTEGER NOT NULL, UNIQUE(from_id, to_id, type));

   CREATE TABLE usage (
     id TEXT PRIMARY KEY, ts INTEGER NOT NULL, request_id TEXT, provider TEXT NOT NULL,
     model TEXT NOT NULL, tier TEXT NOT NULL, input_tokens INTEGER NOT NULL,
     output_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, latency_ms INTEGER NOT NULL,
     cache_hit INTEGER NOT NULL, reason TEXT, agent TEXT, task_id TEXT, project TEXT);
   CREATE INDEX usage_ts ON usage(ts);

   CREATE TABLE audit (
     id TEXT PRIMARY KEY, ts INTEGER NOT NULL, request_id TEXT, task_id TEXT, agent TEXT,
     tool TEXT NOT NULL, input_summary TEXT NOT NULL, result TEXT NOT NULL, risk TEXT NOT NULL,
     approval TEXT NOT NULL, duration_ms INTEGER NOT NULL);
   CREATE INDEX audit_ts ON audit(ts);

   CREATE TABLE requests (
     id TEXT PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL, text TEXT NOT NULL,
     intent TEXT, tier TEXT, response TEXT, ok INTEGER);

   CREATE TABLE tasks (
     id TEXT PRIMARY KEY, request_id TEXT NOT NULL, agent TEXT NOT NULL, title TEXT NOT NULL,
     status TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
]

export async function migrate(db: SqlDriver): Promise<number> {
  await db.execute('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  const rows = await db.select<{ version: number }>('SELECT version FROM schema_version')
  const current = rows[0]?.version ?? 0
  for (let v = current; v < MIGRATIONS.length; v++) {
    // One statement per call: drivers differ on multi-statement support. Migrations contain no inner ';'.
    for (const statement of MIGRATIONS[v]!.split(';').map((s) => s.trim()).filter(Boolean)) {
      await db.execute(statement)
    }
    await db.execute('DELETE FROM schema_version')
    await db.execute('INSERT INTO schema_version (version) VALUES (?)', [v + 1])
  }
  return MIGRATIONS.length
}

export class SettingsRepo {
  constructor(private readonly db: SqlDriver) {}
  async get(key: string): Promise<unknown> {
    const rows = await this.db.select<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
    return rows[0] ? JSON.parse(rows[0].value) : undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    await this.db.execute(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, JSON.stringify(value)],
    )
  }
}
