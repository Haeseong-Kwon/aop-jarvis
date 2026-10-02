import type { SqlDriver, SqlValue } from '@aop/core'
import Database from '@tauri-apps/plugin-sql'

/** tauri-plugin-sql (sqlx/SQLite, FTS5 bundled) behind the runtime's two-method driver. */
export async function openDatabase(): Promise<SqlDriver> {
  const db = await Database.load('sqlite:jarvis.db')
  await db.execute('PRAGMA journal_mode = WAL')
  await db.execute('PRAGMA foreign_keys = ON')
  return {
    async execute(sql: string, params: SqlValue[] = []) {
      await db.execute(sql, params)
    },
    select<T>(sql: string, params: SqlValue[] = []) {
      return db.select<T[]>(sql, params)
    },
  }
}
