import { z } from 'zod';
import type { AuthenticationDatabase } from './auth.js';
import { eventSchema } from '../shared/models.js';
import { HttpError } from './security.js';

export interface Statement {
  sql: string;
  params: (string | number | null)[];
}
export interface Database {
  execute(statement: Statement): Promise<{ rows: unknown[]; changes: number }>;
  batch(statements: Statement[]): Promise<void>;
}
const rowSchema = z.object({ data: z.string() });
export class DocumentStore {
  constructor(
    readonly database: Database,
    readonly authDatabase: AuthenticationDatabase,
  ) {}
  async securityGeneration(userId: string): Promise<number> {
    const row = (
      await this.database.execute({
        sql: 'SELECT generation FROM account_security WHERE userId=?',
        params: [userId],
      })
    ).rows[0];
    return row === undefined
      ? 0
      : z.object({ generation: z.number().int().nonnegative() }).parse(row).generation;
  }
  async get<T>(kind: string, id: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const row = (
      await this.database.execute({
        sql: 'SELECT data FROM documents WHERE kind=? AND id=?',
        params: [kind, id],
      })
    ).rows[0];
    return row ? schema.parse(JSON.parse(rowSchema.parse(row).data)) : undefined;
  }
  async list<T>(kind: string, schema: z.ZodType<T>): Promise<T[]> {
    const data = await this.database.execute({
      sql: 'SELECT data FROM documents WHERE kind=? ORDER BY rowid',
      params: [kind],
    });
    return data.rows.map((row) => schema.parse(JSON.parse(rowSchema.parse(row).data)));
  }
  async query<T>(
    kind: string,
    schema: z.ZodType<T>,
    filters: Partial<
      Record<'projectId' | 'userId' | 'threadId' | 'status' | 'idempotencyKey', string>
    >,
    limit = 1000,
    after = 0,
    descending = false,
  ): Promise<T[]> {
    const fields = z.enum(['projectId', 'userId', 'threadId', 'status', 'idempotencyKey']);
    const clauses = ['kind=?', 'rowid>?'];
    const params: (string | number | null)[] = [kind, after];
    for (const [field, value] of Object.entries(filters)) {
      clauses.push(`json_extract(data,'$.${fields.parse(field)}')=?`);
      params.push(value);
    }
    params.push(limit);
    const result = await this.database.execute({
      sql: `SELECT data FROM documents WHERE ${clauses.join(' AND ')} ORDER BY rowid ${descending ? 'DESC' : 'ASC'} LIMIT ?`,
      params,
    });
    return result.rows.map((row) => schema.parse(JSON.parse(rowSchema.parse(row).data)));
  }
  async page<T>(
    kind: string,
    projectId: string,
    schema: z.ZodType<T>,
    before = Number.MAX_SAFE_INTEGER,
    filters: {
      url?: string | undefined;
      status?: string | undefined;
      search?: string | undefined;
      ids?: string[] | undefined;
    } = {},
  ) {
    const clauses = ['kind=?', "json_extract(data,'$.projectId')=?", 'rowid<?'];
    const params: (string | number | null)[] = [kind, projectId, before];
    if (filters.ids?.length) {
      clauses.push(`json_extract(data,'$.id') IN (${filters.ids.map(() => '?').join(',')})`);
      params.push(...filters.ids);
    }
    if (filters.url) {
      clauses.push("json_extract(data,'$.context.url')=?");
      params.push(filters.url);
    }
    if (filters.status) {
      clauses.push("json_extract(data,'$.status')=?");
      params.push(filters.status);
    }
    if (filters.search) {
      clauses.push(
        "(instr(lower(json_extract(data,'$.context.url')),lower(?))>0 OR EXISTS(SELECT 1 FROM json_each(data,'$.messages') message WHERE instr(lower(json_extract(message.value,'$.body')),lower(?))>0))",
      );
      params.push(filters.search, filters.search);
    }
    const selection =
      kind === 'threads'
        ? "json_set(data,'$.messageCount',json_array_length(data,'$.messages'),'$.messages',json_array(json_set(json_extract(data,'$.messages[0]'),'$.reactions',json('[]'))))"
        : 'data';
    const rows = (
      await this.database.execute({
        sql: `SELECT rowid AS position,${selection} AS data FROM documents WHERE ${clauses.join(' AND ')} ORDER BY rowid DESC LIMIT 51`,
        params,
      })
    ).rows.map((row) => z.object({ position: z.number(), data: z.string() }).parse(row));
    const visible = rows.slice(0, 50);
    return {
      items: visible.map((row) => schema.parse(JSON.parse(row.data))),
      nextBefore: rows.length > 50 ? (visible.at(-1)?.position ?? null) : null,
    };
  }
  write(kind: string, id: string, value: unknown, insert = false): Statement {
    return {
      sql: insert
        ? 'INSERT INTO documents(kind,id,data) VALUES(?,?,?)'
        : 'INSERT INTO documents(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data',
      params: [kind, id, JSON.stringify(value)],
    };
  }
  async put(kind: string, id: string, value: unknown): Promise<void> {
    await this.database.execute(this.write(kind, id, value));
  }
  async insert(kind: string, id: string, value: unknown): Promise<void> {
    await this.database.execute(this.write(kind, id, value, true));
  }
  async delete(kind: string, id: string): Promise<void> {
    await this.database.execute({
      sql: 'DELETE FROM documents WHERE kind=? AND id=?',
      params: [kind, id],
    });
  }
  async take<T>(
    kind: string,
    id: string,
    schema: z.ZodType<T>,
    expected: T,
  ): Promise<T | undefined> {
    const result = await this.database.execute({
      sql: 'DELETE FROM documents WHERE kind=? AND id=? AND data=? RETURNING data',
      params: [kind, id, JSON.stringify(expected)],
    });
    const row = result.rows[0];
    return row ? schema.parse(JSON.parse(rowSchema.parse(row).data)) : undefined;
  }
  async compare<T>(kind: string, id: string, before: T, after: T): Promise<boolean> {
    const result = await this.database.execute({
      sql: 'UPDATE documents SET data=? WHERE kind=? AND id=? AND data=?',
      params: [JSON.stringify(after), kind, id, JSON.stringify(before)],
    });
    return result.changes === 1;
  }
  async atomicCompare(
    items: { kind: string; id: string; before: unknown; after: unknown }[],
    audits: Statement[],
  ): Promise<boolean> {
    const statements: Statement[] = [];
    for (const item of items) {
      statements.push({
        sql: 'UPDATE documents SET data=? WHERE kind=? AND id=? AND data=?',
        params: [JSON.stringify(item.after), item.kind, item.id, JSON.stringify(item.before)],
      });
      statements.push({ sql: 'INSERT INTO transaction_guard(ok) VALUES(changes())', params: [] });
    }
    statements.push(...audits, { sql: 'DELETE FROM transaction_guard', params: [] });
    try {
      await this.database.batch(statements);
      return true;
    } catch (error) {
      if (error instanceof Error && /CHECK constraint failed/i.test(error.message)) return false;
      throw error;
    }
  }
  async mutate<T>(
    kind: string,
    id: string,
    schema: z.ZodType<T>,
    update: (value: T) => T,
  ): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = await this.get(kind, id, schema);
      if (before === undefined) throw new HttpError(404, 'Not found.');
      const after = schema.parse(update(schema.parse(before)));
      if (await this.compare(kind, id, before, after)) return after;
    }
    throw new HttpError(409, 'This item changed concurrently. Refresh and try again.');
  }
  auditStatement(projectId: string, actorId: string, kind: string, resourceId: string): Statement {
    return {
      sql: 'INSERT INTO events(projectId,actorId,kind,resourceId,createdAt) VALUES(?,?,?,?,?)',
      params: [projectId, actorId, kind, resourceId, new Date().toISOString()],
    };
  }
  async audit(projectId: string, actorId: string, kind: string, resourceId: string): Promise<void> {
    await this.database.execute(this.auditStatement(projectId, actorId, kind, resourceId));
  }
  async events(projectId: string, cursor: number) {
    return (
      await this.database.execute({
        sql: 'SELECT * FROM events WHERE projectId=? AND seq>? ORDER BY seq LIMIT 200',
        params: [projectId, cursor],
      })
    ).rows.map((value) => eventSchema.parse(value));
  }
  async limit(id: string, max: number): Promise<void> {
    const now = Date.now();
    const result = await this.database.execute({
      sql: 'INSERT INTO rate_limits(id,count,resetAt) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=CASE WHEN resetAt<? THEN 1 ELSE count+1 END,resetAt=CASE WHEN resetAt<? THEN excluded.resetAt ELSE resetAt END RETURNING count',
      params: [id, now + 60_000, now, now],
    });
    const row = z.object({ count: z.number() }).parse(result.rows[0]);
    if (row.count > max) throw new HttpError(429, 'Too many requests. Try again in a minute.');
  }
}
