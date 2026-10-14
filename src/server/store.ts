import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { DocumentStore } from './document-store.js';
import type { Statement } from './document-store.js';

export class Store extends DocumentStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    db.exec(readFileSync('migrations/0001_feedback.sql', 'utf8'));
    db.exec(readFileSync('migrations/0002_auth.sql', 'utf8'));
    const execute = (statement: Statement) => {
      const prepared = db.prepare(statement.sql);
      if (/^SELECT|\bRETURNING\b/i.test(statement.sql)) {
        const rows = prepared.all(...statement.params);
        const meta = z
          .object({ changes: z.number() })
          .parse(db.prepare('SELECT changes() AS changes').get());
        return { rows, changes: meta.changes };
      }
      return { rows: [], changes: Number(prepared.run(...statement.params).changes) };
    };
    super(
      {
        execute: (statement) => Promise.resolve(execute(statement)),
        batch: (statements) => {
          db.exec('BEGIN IMMEDIATE');
          try {
            for (const statement of statements) execute(statement);
            db.exec('COMMIT');
            return Promise.resolve();
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        },
      },
      db,
    );
    this.db = db;
  }
  close(): void {
    this.db.close();
  }
}
