import type { D1Database } from '@cloudflare/workers-types';
import { DocumentStore } from './document-store.js';

export function d1Store(database: D1Database): DocumentStore {
  return new DocumentStore(
    {
      async execute(statement) {
        const result = await database
          .prepare(statement.sql)
          .bind(...statement.params)
          .all();
        return { rows: result.results, changes: result.meta.changes };
      },
      async batch(statements) {
        await database.batch(
          statements.map((statement) => database.prepare(statement.sql).bind(...statement.params)),
        );
      },
    },
    database,
  );
}
