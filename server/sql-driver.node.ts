/** Node-only driver used by the test-suite (built on the built-in node:sqlite). */
import { DatabaseSync } from 'node:sqlite';
import type { SqlDriver, SqlValue } from './sql-driver.ts';

export function createNodeDriver(path = ':memory:'): SqlDriver {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys = ON');
  let depth = 0;
  let savepointId = 0;

  return {
    supportsConnectionPragmas: true,
    query(sql, params) {
      const stmt = database.prepare(sql);
      return stmt.all(...(params as never[])) as Array<Record<string, unknown>>;
    },
    exec(sql) {
      database.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      const name = `sp_${++savepointId}`;
      if (depth === 0) database.exec('BEGIN IMMEDIATE');
      else database.exec(`SAVEPOINT ${name}`);
      depth++;
      try {
        const result = fn();
        depth--;
        if (depth === 0) database.exec('COMMIT');
        else database.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        depth--;
        if (depth === 0) database.exec('ROLLBACK');
        else database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        throw error;
      }
    },
    close() {
      database.close();
    },
  };
}

export type { SqlValue };
