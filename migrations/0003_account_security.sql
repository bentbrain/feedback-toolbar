-- Application permission fence; Better Auth continues to own identity and key verification.
CREATE TABLE IF NOT EXISTS account_security (
  userId TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0)
);
