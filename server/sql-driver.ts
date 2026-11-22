/**
 * Minimal synchronous SQL driver abstraction.
 *
 * Production (Cloudflare): Durable Object SQLite storage (`ctx.storage.sql`),
 * which is synchronous just like better-sqlite3 — so the route code does not
 * need to become async.
 * Tests (Node): `node:sqlite`.
 */
export type SqlValue = string | number | null | Uint8Array | ArrayBuffer;

export interface SqlDriver {
  /** Execute one statement (with bindings) and return all rows. */
  query(sql: string, params: SqlValue[]): Array<Record<string, unknown>>;
  /** Execute one or more statements without bindings. */
  exec(sql: string): void;
  /** Run fn atomically; nested calls join/savepoint the outer transaction. */
  transaction<T>(fn: () => T): T;
  /** Optional: whether PRAGMA statements that change connection mode are allowed. */
  readonly supportsConnectionPragmas: boolean;
  close?(): void;
}

/** Structural type for the parts of DurableObjectStorage we use. */
export interface DoStorageLike {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> } };
  transactionSync<T>(fn: () => T): T;
}

export function createDurableObjectDriver(storage: DoStorageLike): SqlDriver {
  return {
    supportsConnectionPragmas: false,
    query(sql, params) {
      return storage.sql.exec(sql, ...params).toArray();
    },
    exec(sql) {
      storage.sql.exec(sql).toArray();
    },
    transaction(fn) {
      return storage.transactionSync(fn);
    },
  };
}
