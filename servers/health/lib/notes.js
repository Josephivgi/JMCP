"use strict";

// Things agents want the user to see. An agent posts a short note (a finding,
// a warning, a result) with show_user; the JMCP Health page lists them until
// the user dismisses them.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const LEVELS = ["info", "good", "warning", "problem"];
const MAX_BODY = 8000;
const KEEP = 500;

function dbHome(home) {
  if (home) return path.join(home, ".jmcp");
  return process.env.JMCP_HOME ? path.resolve(process.env.JMCP_HOME) : path.join(os.homedir(), ".jmcp");
}

function withDb(home, fn) {
  const dir = dbHome(home);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "health.db"));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;" +
        "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, level TEXT NOT NULL, about TEXT NOT NULL, author TEXT NOT NULL, created_at INTEGER NOT NULL, dismissed_at INTEGER);",
    );
    return fn(db);
  } finally {
    db.close();
  }
}

function row(r) {
  return { id: r.id, title: r.title, body: r.body, level: r.level, about: r.about || "", author: r.author, createdAt: r.created_at, dismissedAt: r.dismissed_at || null };
}

// Newest first. dismissed: also return notes the user has dismissed.
function list(home, opts) {
  const all = Boolean(opts && opts.dismissed);
  return withDb(home, (db) =>
    db.prepare("SELECT * FROM notes" + (all ? "" : " WHERE dismissed_at IS NULL") + " ORDER BY created_at DESC, rowid DESC").all().map(row),
  );
}

function add(home, input) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw new Error("title must not be empty.");
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (body.length > MAX_BODY) throw new Error("body is longer than " + MAX_BODY + " characters. Keep it short; the user reads it in a card.");
  const level = input.level === undefined || input.level === "" ? "info" : String(input.level);
  if (!LEVELS.includes(level)) throw new Error("level must be one of " + LEVELS.join(", ") + ".");
  const note = {
    id: crypto.randomUUID(),
    title: title.slice(0, 200),
    body,
    level,
    about: typeof input.about === "string" ? input.about.trim().slice(0, 120) : "",
    author: String(input.author || "an agent").slice(0, 80),
    created_at: Date.now(),
  };
  return withDb(home, (db) => {
    db.prepare("INSERT INTO notes (id, title, body, level, about, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(note.id, note.title, note.body, note.level, note.about, note.author, note.created_at);
    // Old dismissed notes go first when the list gets long.
    db.prepare("DELETE FROM notes WHERE id IN (SELECT id FROM notes ORDER BY (dismissed_at IS NULL) DESC, created_at DESC LIMIT -1 OFFSET ?)").run(KEEP);
    return row(note);
  });
}

function dismiss(home, id, back) {
  return withDb(home, (db) => {
    const r = db.prepare("UPDATE notes SET dismissed_at = ? WHERE id = ?").run(back ? null : Date.now(), String(id));
    if (!r.changes) throw new Error("No note with id " + id + ".");
    return true;
  });
}

function dismissAll(home) {
  return withDb(home, (db) => db.prepare("UPDATE notes SET dismissed_at = ? WHERE dismissed_at IS NULL").run(Date.now()).changes);
}

function remove(home, id) {
  return withDb(home, (db) => {
    const r = db.prepare("DELETE FROM notes WHERE id = ?").run(String(id));
    if (!r.changes) throw new Error("No note with id " + id + ".");
    return true;
  });
}

module.exports = { list, add, dismiss, dismissAll, remove, LEVELS, MAX_BODY };
