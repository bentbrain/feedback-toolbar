CREATE TABLE IF NOT EXISTS documents (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(kind,id)
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  projectId TEXT NOT NULL,
  actorId TEXT NOT NULL,
  kind TEXT NOT NULL,
  resourceId TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_project ON events(projectId,seq);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON documents(lower(json_extract(data,'$.email'))) WHERE kind='users';
CREATE UNIQUE INDEX IF NOT EXISTS jobs_request_key ON documents(json_extract(data,'$.projectId'),json_extract(data,'$.idempotencyKey')) WHERE kind='jobs';
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_thread ON documents(json_extract(data,'$.threadId')) WHERE kind='jobs' AND json_extract(data,'$.status') IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS jobs_running_project ON documents(json_extract(data,'$.projectId')) WHERE kind='jobs' AND json_extract(data,'$.status')='running';
CREATE TABLE IF NOT EXISTS rate_limits (id TEXT PRIMARY KEY, count INTEGER NOT NULL, resetAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS transaction_guard (ok INTEGER NOT NULL CHECK(ok=1));
