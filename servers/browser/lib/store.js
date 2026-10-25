"use strict";

// One browsers database for every jmcp-browser server and the JMCP app. Each
// row is a headless browser an agent opened: who opened it, where its
// DevTools port is, and what page it is on. The app reads it to show the
// browsers live; a server that ends marks its rows closed.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

function dbHome(home) {
  if (home) return path.join(home, ".jmcp");
  return process.env.JMCP_HOME ? path.resolve(process.env.JMCP_HOME) : path.join(os.homedir(), ".jmcp");
}

function withDb(home, fn) {
  const dir = dbHome(home);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "browser.db"));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;" +
        "CREATE TABLE IF NOT EXISTS browsers (id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, cwd TEXT NOT NULL, server_pid INTEGER NOT NULL, browser_pid INTEGER, port INTEGER, browser_ws TEXT, program TEXT NOT NULL, profile TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open', 'closed')), url TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', last_action TEXT NOT NULL DEFAULT '', closed_reason TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER);" +
        "CREATE INDEX IF NOT EXISTS browsers_status ON browsers (status, updated_at);",
    );
    return fn(db);
  } finally {
    db.close();
  }
}

const get = (db, id) => db.prepare("SELECT * FROM browsers WHERE id = ?").get(id) || null;

function add(home, b) {
  return withDb(home, (db) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare("INSERT INTO browsers (id, name, agent, cwd, server_pid, browser_pid, port, browser_ws, program, profile, status, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
      .run(id, b.name, b.agent || "an agent", b.cwd || "", b.serverPid, b.browserPid || null, b.port || null, b.browserWs || "", b.program, b.profile, now, now);
    return get(db, id);
  });
}

// Only the page fields an agent's actions change.
function touch(home, id, patch) {
  const keys = ["url", "title", "last_action"].filter((k) => typeof patch[k] === "string");
  return withDb(home, (db) => {
    if (keys.length) {
      db.prepare("UPDATE browsers SET " + keys.map((k) => k + " = ?").join(", ") + ", updated_at = ? WHERE id = ? AND status = 'open'")
        .run(...keys.map((k) => patch[k].slice(0, 2000)), Date.now(), id);
    }
    return get(db, id);
  });
}

function close(home, id, reason) {
  return withDb(home, (db) => db.prepare("UPDATE browsers SET status = 'closed', closed_reason = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'").run(String(reason || "closed"), Date.now(), Date.now(), id).changes > 0);
}

function byId(home, id) {
  return withDb(home, (db) => get(db, id));
}

function open(home) {
  return withDb(home, (db) => db.prepare("SELECT * FROM browsers WHERE status = 'open' ORDER BY started_at").all());
}

// Closed browsers, newest first; older ones are dropped so the table stays small.
function recent(home, limit) {
  return withDb(home, (db) => {
    db.prepare("DELETE FROM browsers WHERE status = 'closed' AND id NOT IN (SELECT id FROM browsers WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 200)").run();
    return db.prepare("SELECT * FROM browsers WHERE status = 'closed' ORDER BY closed_at DESC LIMIT ?").all(Math.max(1, Math.min(200, Number(limit) || 20)));
  });
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

module.exports = { add, touch, close, byId, open, recent, alive, dbHome };
