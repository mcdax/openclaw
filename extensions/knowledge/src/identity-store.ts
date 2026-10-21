import { constants, closeSync, fsyncSync, lstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  tableExists,
  tableHasColumn,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { Check } from "typebox/value";
import type { IdentityStore } from "./real-vault.js";
import {
  ensureKnowledgeSchema,
  UnrecognizedSchema,
  type KnowledgeSchema,
} from "./storage-schema.js";
import type { StorageTables } from "./storage-tables.js";
import { Manifest } from "./store-manifest.js";

const BUSY_TIMEOUT_MS = 5000;
const unavailable = () =>
  new Error(
    "Knowledge identity checkpoint unavailable; preserve the database and resolve recovery before reading.",
  );

/** Operational database schema. A store written before version stamping is
 * dated by its tables; only a database this call just created may be empty. */
const stateSchema = (created: boolean): KnowledgeSchema => ({
  store: "state",
  steps: [
    {
      version: 1,
      apply: (db) =>
        db.exec(
          "CREATE TABLE identities (agent_key TEXT PRIMARY KEY, manifest TEXT NOT NULL) STRICT",
        ),
    },
    {
      version: 2,
      apply: (db) =>
        db.exec(`CREATE TABLE IF NOT EXISTS mutations (
          scope TEXT NOT NULL, request TEXT NOT NULL, intent TEXT NOT NULL,
          state TEXT NOT NULL, plan TEXT NOT NULL, receipt TEXT NOT NULL,
          PRIMARY KEY(scope, request)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS observations (
          scope TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL,
          revision INTEGER NOT NULL, raw TEXT NOT NULL, PRIMARY KEY(scope,id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS history (
          sequence INTEGER PRIMARY KEY, scope TEXT NOT NULL, id TEXT NOT NULL,
          provenance TEXT NOT NULL, at TEXT NOT NULL, path TEXT NOT NULL,
          revision INTEGER NOT NULL, hash TEXT NOT NULL, raw TEXT NOT NULL
        ) STRICT;`),
    },
    {
      version: 3,
      apply: (db) =>
        db.exec(`CREATE TABLE git_jobs (
          sequence INTEGER PRIMARY KEY, scope TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
          batch TEXT NOT NULL, state TEXT NOT NULL, commit_id TEXT, message TEXT NOT NULL
        ) STRICT;
        CREATE TABLE git_files (scope TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(scope,path)) STRICT;`),
    },
    {
      version: 4,
      apply: (db) =>
        db.exec(`CREATE TABLE attachment_uploads (
          scope TEXT NOT NULL, request TEXT NOT NULL, metadata TEXT NOT NULL,
          received INTEGER NOT NULL, receipt TEXT, PRIMARY KEY(scope,request)
        ) STRICT;
        CREATE TABLE attachment_chunks (
          scope TEXT NOT NULL, request TEXT NOT NULL, offset INTEGER NOT NULL,
          hash TEXT NOT NULL, size INTEGER NOT NULL, final INTEGER NOT NULL, data BLOB,
          PRIMARY KEY(scope,request,offset)
        ) STRICT;`),
    },
    // Writer attribution: the agent that published a revision. Stores are
    // shared, so the partition no longer implies the author.
    { version: 5, apply: (db) => db.exec("ALTER TABLE history ADD COLUMN agent_id TEXT") },
  ],
  detect: (db) => {
    if (!tableExists(db, "identities")) {
      return created ? 0 : undefined;
    }
    if (!tableExists(db, "mutations")) {
      return 1;
    }
    if (!tableExists(db, "git_jobs")) {
      return 2;
    }
    if (!tableExists(db, "attachment_uploads")) {
      return 3;
    }
    return tableHasColumn(db, "history", "agent_id") ? 5 : 4;
  },
});

/** Short-lived connections: no native handles survive a query or plugin reload. */
export class SqliteIdentityStore implements IdentityStore {
  constructor(private readonly filename: string) {}
  withDatabase<T>(run: (db: DatabaseSync) => T): T {
    let created = false;
    try {
      // Operational state is outside the editable vault. Reject link aliases;
      // the parent must already exist and be selected by operator configuration.
      if (realpathSync(path.dirname(this.filename)) !== path.dirname(this.filename)) {
        throw unavailable();
      }
      const fd = openSync(
        this.filename,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      closeSync(fd);
      created = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw unavailable();
      }
    }
    const before = lstatSync(this.filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw unavailable();
    }
    const db = openNodeSqliteDatabase(this.filename, { timeout: BUSY_TIMEOUT_MS });
    try {
      const after = lstatSync(this.filename);
      if (before.dev !== after.dev || before.ino !== after.ino || after.nlink !== 1) {
        throw unavailable();
      }
      try {
        ensureKnowledgeSchema(db, stateSchema(created));
      } catch (e) {
        throw e instanceof UnrecognizedSchema ? unavailable() : e;
      }
      if (created) {
        const parent = openSync(path.dirname(this.filename), constants.O_RDONLY);
        try {
          fsyncSync(parent);
        } finally {
          closeSync(parent);
        }
      }
      // Additive indexes remain readable by older plugin versions. The activity
      // projection joins exact publication snapshots to history; without this
      // key every published record scans the entire history table again.
      // Per-record latest-writer lookups need (scope,id,sequence); otherwise the
      // planner walks the scope's whole history backwards for each record.
      db.exec(`CREATE INDEX IF NOT EXISTS history_record_snapshot ON history(scope,id,hash,revision,provenance,sequence);
        CREATE INDEX IF NOT EXISTS history_scope_sequence ON history(scope,sequence);
        CREATE INDEX IF NOT EXISTS history_record_sequence ON history(scope,id,sequence);`);
      return run(db);
    } finally {
      db.close();
    }
  }
  async lookup(key: string): Promise<Manifest | undefined> {
    return this.withDatabase((db) => {
      const row = db.prepare("SELECT manifest FROM identities WHERE agent_key = ?").get(key);
      if (!row) {
        return undefined;
      }
      const value: unknown = JSON.parse(String(row.manifest));
      if (!Check(Manifest, value)) {
        throw unavailable();
      }
      return value;
    });
  }
  async registerIfAbsent(key: string, value: Manifest): Promise<boolean> {
    if (!Check(Manifest, value)) {
      throw unavailable();
    }
    return this.withDatabase((db) => registerIdentity(db, key, JSON.stringify(value)));
  }
}

/** Record an identity checkpoint unless one already exists; true when this call wrote it. */
export function registerIdentity(db: DatabaseSync, key: string, manifest: string): boolean {
  const result = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<StorageTables>(db)
      .insertInto("identities")
      .values({ agent_key: key, manifest })
      .onConflict((oc) => oc.doNothing()),
  );
  return result.numAffectedRows === 1n;
}
