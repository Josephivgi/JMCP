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

// control: '' (the agent drives), 'asked' (the agent asked the user to take
// over) or 'user' (the user is driving from the JMCP app; the agent waits).
const HANDOFF_COLUMNS = [
  ["target_id", "TEXT NOT NULL DEFAULT ''"],
  ["control", "TEXT NOT NULL DEFAULT ''"],
  ["ask_reason", "TEXT NOT NULL DEFAULT ''"],
  ["ask_at", "INTEGER"],
  ["handed_back_at", "INTEGER"],
  ["user_note", "TEXT NOT NULL DEFAULT ''"],
];

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
    // Hand-off columns, added to databases made before them.
    const have = new Set(db.prepare("PRAGMA table_info(browsers)").all().map((c) => c.name));
    for (const [col, def] of HANDOFF_COLUMNS) {
      if (have.has(col)) continue;
      try {
        db.exec("ALTER TABLE browsers ADD COLUMN " + col + " " + def);
      } catch (e) {
        // Another process added it first.
        if (!/duplicate column/i.test(e.message)) throw e;
      }
    }
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
  const keys = ["url", "title", "last_action", "target_id"].filter((k) => typeof patch[k] === "string");
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

// The agent asks the user to take over. A user already in control stays so.
function ask(home, id, reason) {
  return withDb(home, (db) => {
    const now = Date.now();
    db.prepare("UPDATE browsers SET control = CASE control WHEN 'user' THEN 'user' ELSE 'asked' END, ask_reason = ?, ask_at = ?, user_note = '', updated_at = ? WHERE id = ? AND status = 'open'")
      .run(String(reason).slice(0, 500), now, now, id);
    return get(db, id);
  });
}

function takeControl(home, id) {
  return withDb(home, (db) => db.prepare("UPDATE browsers SET control = 'user', updated_at = ? WHERE id = ? AND status = 'open'").run(Date.now(), id).changes > 0);
}

function handBack(home, id, note) {
  return withDb(home, (db) => {
    const now = Date.now();
    return db.prepare("UPDATE browsers SET control = '', ask_reason = '', handed_back_at = ?, user_note = ?, updated_at = ? WHERE id = ? AND status = 'open' AND control <> ''")
      .run(now, String(note || "").slice(0, 2000), now, id).changes > 0;
  });
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

module.exports = { add, touch, close, ask, takeControl, handBack, byId, open, recent, alive, dbHome };
