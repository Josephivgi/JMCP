"use strict";

// One rules database for the app and every installed agent. Every rule
// applies to every agent.

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
  const db = new DatabaseSync(path.join(dir, "rules.db"));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;" +
        "CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('do', 'dont')), text TEXT NOT NULL, agents TEXT NOT NULL, enabled INTEGER NOT NULL, position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    );
    return fn(db);
  } finally {
    db.close();
  }
}

function kindValue(kind) {
  if (kind !== "do" && kind !== "dont") throw new Error("kind must be 'do' or 'dont'.");
  return kind;
}

function textValue(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("text must not be empty.");
  return text.trim();
}

// The agents column is left over from per-agent rules and is ignored.
function row({ agents, ...rule }) {
  return { ...rule, enabled: Boolean(rule.enabled) };
}

function list(home) {
  return withDb(home, (db) =>
    db.prepare("SELECT * FROM rules ORDER BY position, created_at, id").all().map(row),
  );
}

function add(home, { kind, text } = {}) {
  kind = kindValue(kind);
  text = textValue(text);
  return withDb(home, (db) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    const position = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM rules").get().next;
    db.prepare("INSERT INTO rules (id, kind, text, agents, enabled, position, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)")
      .run(id, kind, text, "[]", position, now, now);
    return row(db.prepare("SELECT * FROM rules WHERE id = ?").get(id));
  });
}

function update(home, id, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("patch must be an object.");
  const changes = {};
  if (Object.hasOwn(patch, "kind")) changes.kind = kindValue(patch.kind);
  if (Object.hasOwn(patch, "text")) changes.text = textValue(patch.text);
  if (Object.hasOwn(patch, "enabled")) {
    if (typeof patch.enabled !== "boolean") throw new Error("enabled must be a boolean.");
    changes.enabled = Number(patch.enabled);
  }
  if (Object.hasOwn(patch, "position")) {
    if (!Number.isInteger(patch.position)) throw new Error("position must be an integer.");
    changes.position = patch.position;
  }
  return withDb(home, (db) => {
    if (!db.prepare("SELECT id FROM rules WHERE id = ?").get(id)) return null;
    const keys = Object.keys(changes);
    if (keys.length) {
      db.prepare("UPDATE rules SET " + keys.map((key) => key + " = ?").join(", ") + ", updated_at = ? WHERE id = ?")
        .run(...keys.map((key) => changes[key]), Date.now(), id);
    }
    return row(db.prepare("SELECT * FROM rules WHERE id = ?").get(id));
  });
}

function remove(home, id) {
  return withDb(home, (db) => db.prepare("DELETE FROM rules WHERE id = ?").run(id).changes > 0);
}

function active(home) {
  return list(home).filter((rule) => rule.enabled);
}

function instructions(rules) {
  const section = (title, kind) => {
    const items = rules.filter((rule) => rule.kind === kind).map((rule) => "- " + rule.text);
    return items.length ? title + "\n" + items.join("\n") : "";
  };
  return [section("Do:", "do"), section("Don't:", "dont")].filter(Boolean).join("\n\n");
}

module.exports = { list, add, update, remove, active, instructions };
