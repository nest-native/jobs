import { Logger } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

type Db = NodePgDatabase<Record<string, never>>;

/** A node-postgres `Pool`, recognized by shape so that loading this module never loads `pg`. */
interface PgPool {
  connect(): Promise<PgPoolClient>;
  totalCount: number;
  listenerCount?(event: 'error'): number;
}
interface PgPoolClient {
  query(text: string): Promise<unknown>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
  release(error?: Error): void;
}

const isPgPool = (client: unknown): client is PgPool =>
  typeof client === 'object' &&
  client !== null &&
  typeof (client as Partial<PgPool>).connect === 'function' &&
  typeof (client as Partial<PgPool>).totalCount === 'number';

const logger = new Logger('JobsPostgres');
// Pools already warned that they have no `error` listener.
const unguardedPools = new WeakSet<object>();

/**
 * Warns once per pool that has no `error` listener. node-postgres reports a
 * connection an idle client loses as the pool's `error` event, and with no
 * listener that event crashes the process: every client the stores release
 * goes back into that state, so the listener is load-bearing.
 */
function warnIfUnguarded(pool: PgPool): void {
  if (unguardedPools.has(pool) || pool.listenerCount?.('error') !== 0) return;
  unguardedPools.add(pool);
  logger.warn(
    "the node-postgres Pool the jobs stores run on has no 'error' listener; node-postgres crashes the process when an idle client loses its connection, so add pool.on('error', ...)",
  );
}

/** Where a drizzle database keeps its query logger and cache (drizzle internals, read defensively). */
interface DrizzleSessionOwner {
  session?: { options?: { logger?: unknown; cache?: unknown } };
}

/**
 * Runs `work` in its own READ COMMITTED transaction, whatever the server
 * default: a claim's locking scan then skips rows another claim holds instead
 * of failing with 40001 (Postgres) or gap-locking every concurrent enqueue.
 *
 * On a node-postgres `Pool` it checks the client out itself instead of going
 * through drizzle's `transaction()`, which leaves the checked-out client without
 * an `error` listener and sends BEGIN outside its cleanup. A connection the
 * server dropped mid-transaction (a failover, `pg_terminate_backend`) then
 * crashed the process, and one dropped at BEGIN was never returned to the pool.
 * Here the client listens for errors while it is out, a failed ROLLBACK never
 * hides the original error, and a broken connection is released with its error
 * so the pool discards it. Anything else (PGlite, a single `Client`) goes through
 * drizzle's `transaction()`.
 */
export async function readCommitted<T>(db: unknown, work: (tx: Db) => Promise<T>): Promise<T> {
  const pool = (db as { $client?: unknown }).$client;
  if (!isPgPool(pool)) {
    return (db as Db).transaction((tx) => work(tx as unknown as Db), {
      isolationLevel: 'read committed',
    });
  }
  warnIfUnguarded(pool);
  // The pool is shaped like node-postgres's, so its drizzle driver (and `pg`)
  // loads here, before a client is checked out. The caller's query logger and
  // cache carry over, so the stores' statements show up where the
  // application's do.
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { logger: queryLogger, cache } = (db as DrizzleSessionOwner).session?.options ?? {};
  const client = await pool.connect();
  let broken: Error | undefined;
  const onError = (error: Error): void => {
    broken = error;
  };
  client.on('error', onError);
  let result: T;
  try {
    await client.query('begin isolation level read committed');
    result = await work(drizzle(client as never, { logger: queryLogger, cache } as never) as unknown as Db);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch((rollbackError: Error) => {
      broken ??= rollbackError;
    });
    throw error;
  } finally {
    client.removeListener('error', onError);
    client.release(broken);
  }
  return result;
}
