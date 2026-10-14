import { z } from 'zod';
import {
  connectionSchema,
  ConnectionError,
  exchangeConnection,
  revokeConnection,
} from '../shared/oauth.js';

type Connection = z.infer<typeof connectionSchema>;
const recordSchema = z.object({ connection: connectionSchema, expires: z.number() });
const prefix = 'feedback-connection:';
const lifetime = 8 * 60 * 60_000;

// sessionStorage holds only a pointer. Copied tabs read and rotate the same record under a lock.
// If embedded storage or Web Locks is unavailable, each iframe keeps its own grant in memory.
export function createConnectionStore(key: string, server: string) {
  let memory: Connection | null = null;
  let id: string | null = null;
  let shared = false;
  const browser: { locks?: LockManager } = navigator;
  try {
    if (browser.locks) {
      const probe = `${prefix}${crypto.randomUUID()}`;
      localStorage.setItem(probe, '');
      localStorage.removeItem(probe);
      sessionStorage.setItem(`${key}:probe`, '');
      sessionStorage.removeItem(`${key}:probe`);
      id = sessionStorage.getItem(key);
      shared = true;
      // Old per-tab token copies cannot safely resume after another tab rotates them.
      if (id && !/^[a-f0-9-]{36}$/.test(id)) {
        sessionStorage.removeItem(key);
        id = null;
      }
      for (const name of Object.keys(localStorage)) {
        if (!name.startsWith(prefix)) continue;
        const record = recordSchema.safeParse(JSON.parse(localStorage.getItem(name) ?? 'null'));
        if (!record.success || record.data.expires <= Date.now()) localStorage.removeItem(name);
      }
    }
  } catch {
    shared = false;
    id = null;
  }
  const read = (): Connection | null => {
    if (!shared || !id) return memory;
    try {
      const result = recordSchema.safeParse(
        JSON.parse(localStorage.getItem(`${prefix}${id}`) ?? 'null'),
      );
      if (result.success && result.data.expires > Date.now()) return result.data.connection;
      return null;
    } catch {
      return null;
    }
  };
  const start = (connection: Connection) => {
    memory = connection;
    if (!shared) return;
    try {
      id = crypto.randomUUID();
      localStorage.setItem(
        `${prefix}${id}`,
        JSON.stringify({ connection, expires: Date.now() + lifetime }),
      );
      sessionStorage.setItem(key, id);
    } catch {
      // Never persist a rotating token in a per-tab copy as a storage fallback.
      shared = false;
      id = null;
    }
  };
  const locked = async <T>(operation: () => Promise<T>): Promise<T> =>
    shared && id
      ? navigator.locks.request(
          `${prefix}${id}`,
          { signal: AbortSignal.timeout(60_000) },
          operation,
        )
      : operation();
  let pending: Promise<Connection> | null = null;
  const current = () => {
    pending ??= locked(async () => {
      const previous = read();
      if (!previous)
        throw new ConnectionError('Your connection expired or was revoked. Sign in again.', true);
      if (previous.expiresAt >= Date.now() + 60_000) return previous;
      const result = await exchangeConnection(server, previous.clientId, {
        refreshToken: previous.refreshToken,
      });
      if (!result.connection) throw new Error('Connection is busy. Try again shortly.');
      const connection = { ...result.connection, user: result.connection.user ?? previous.user };
      if (shared && id) {
        const record = recordSchema.parse(
          JSON.parse(localStorage.getItem(`${prefix}${id}`) ?? 'null'),
        );
        localStorage.setItem(`${prefix}${id}`, JSON.stringify({ ...record, connection }));
      }
      memory = connection;
      return connection;
    }).finally(() => {
      pending = null;
    });
    return pending;
  };
  const clear = () => {
    memory = null;
    if (shared && id) {
      localStorage.removeItem(`${prefix}${id}`);
      sessionStorage.removeItem(key);
    }
    id = null;
  };
  const signOut = async () => {
    await pending?.catch(() => undefined);
    return locked(async () => {
      try {
        const connection = read();
        if (connection)
          await revokeConnection(server, connection.clientId, connection.refreshToken);
      } finally {
        clear();
      }
    });
  };
  return { read, start, current, signOut, clear };
}
