"use strict";

// One memory database for the app and every installed agent. A memory is a
// short named note (a fact, a preference, a decision) that any agent can find
// later. Agents save and search them through jmcp-memory; the JMCP app edits
// them too.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const MAX_BODY = 20000;

function dbHome(home) {
  if (home) return path.join(home, ".jmcp");
  return process.env.JMCP_HOME ? path.resolve(process.env.JMCP_HOME) : path.join(os.homedir(), ".jmcp");
}

function withDb(home, fn) {
  const dir = dbHome(home);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "memory.db"));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;" +
        "CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL, author TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    );
    return fn(db);
  } finally {
    db.close();
  }
}

// "Prefers dark mode!" -> "prefers-dark-mode"
function slug(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function nameValue(name) {
  const s = slug(name);
  if (!s) throw new Error("name must have at least one letter or number.");
  return s;
}

function titleValue(title) {
  if (typeof title !== "string" || !title.trim()) throw new Error("title must not be empty.");
  return title.trim().slice(0, 200);
}

function bodyValue(body) {
  if (typeof body !== "string" || !body.trim()) throw new Error("body must not be empty.");
  if (body.length > MAX_BODY) throw new Error("body is longer than " + MAX_BODY + " characters. Split it into smaller memories.");
  return body.trim();
}

// Things that look like keys, tokens or passwords. Memories are plain text
// every agent reads, so agents must not put secrets in them.
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/, "an API key (sk-...)"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/, "a GitHub token"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/, "a Stripe key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a JWT"],
  [/\b(?:password|passwd|pwd)\b\s*[:=]\s*["']?(?!(?:none|null|empty|unset|required|redacted|hidden|changeme)\b|<|\*+|x{3,})[^\s"']{4,}/i, "a password"],
  [/\b(?:secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[^\s"']{8,}/i, "a secret or key value"],
];

// The kind of secret found in text, or "".
function findSecret(text) {
  for (const [re, what] of SECRETS) if (re.test(String(text || ""))) return what;
  return "";
}

function tagsValue(tags) {
  if (tags === undefined || tags === null) return [];
  const list = Array.isArray(tags) ? tags : String(tags).split(",");
  return [...new Set(list.map(slug).filter(Boolean))].slice(0, 12);
}

function row(r) {
  if (!r) return null;
  return { ...r, tags: JSON.parse(r.tags) };
}

function list(home) {
  return withDb(home, (db) => db.prepare("SELECT * FROM memories ORDER BY updated_at DESC, name").all().map(row));
}

// One memory. Agents name memories, so opts.byName looks at names only;
// the app passes ids. Without it: by id, else by name, never both.
function find(db, ref, opts) {
  const byName = () => db.prepare("SELECT * FROM memories WHERE name = ?").get(slug(ref));
  if (opts && opts.byName) return byName();
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(String(ref)) || byName();
}

function get(home, ref, opts) {
  return withDb(home, (db) => row(find(db, ref, opts)));
}

// Create, or replace the memory with the same name. Returns {memory, created}.
function save(home, { name, title, body, tags, author } = {}) {
  title = titleValue(title);
  body = bodyValue(body);
  const key = nameValue(name || title);
  const tagList = JSON.stringify(tagsValue(tags));
  const who = String(author || "JMCP app").slice(0, 80);
  return withDb(home, (db) => {
    // Immediate, so two agents saving the same new name cannot both insert.
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = upsert(db, key, title, body, tagList, who);
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  });
}

function upsert(db, key, title, body, tagList, who) {
  const now = Date.now();
  const old = db.prepare("SELECT id FROM memories WHERE name = ?").get(key);
  if (old) {
    db.prepare("UPDATE memories SET title = ?, body = ?, tags = ?, author = ?, updated_at = ? WHERE id = ?").run(title, body, tagList, who, now, old.id);
    return { memory: row(db.prepare("SELECT * FROM memories WHERE id = ?").get(old.id)), created: false };
  }
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO memories (id, name, title, body, tags, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, key, title, body, tagList, who, now, now);
  return { memory: row(db.prepare("SELECT * FROM memories WHERE id = ?").get(id)), created: true };
}

// Edit by id from the app. A new name must not belong to another memory.
function update(home, id, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("patch must be an object.");
  const changes = {};
  if (Object.hasOwn(patch, "name")) changes.name = nameValue(patch.name);
  if (Object.hasOwn(patch, "title")) changes.title = titleValue(patch.title);
  if (Object.hasOwn(patch, "body")) changes.body = bodyValue(patch.body);
  if (Object.hasOwn(patch, "tags")) changes.tags = JSON.stringify(tagsValue(patch.tags));
  return withDb(home, (db) => {
    if (!db.prepare("SELECT id FROM memories WHERE id = ?").get(id)) return null;
    if (changes.name && db.prepare("SELECT id FROM memories WHERE name = ? AND id != ?").get(changes.name, id)) throw new Error("Another memory is already named " + changes.name + ".");
    const keys = Object.keys(changes);
    if (keys.length) {
      db.prepare("UPDATE memories SET " + keys.map((k) => k + " = ?").join(", ") + ", author = ?, updated_at = ? WHERE id = ?").run(...keys.map((k) => changes[k]), "JMCP app", Date.now(), id);
    }
    return row(db.prepare("SELECT * FROM memories WHERE id = ?").get(id));
  });
}

function remove(home, ref, opts) {
  return withDb(home, (db) => {
    const m = find(db, ref, opts);
    return m ? db.prepare("DELETE FROM memories WHERE id = ?").run(m.id).changes > 0 : false;
  });
}

// Every word must appear in the name, title, body or tags. Title and tag
// hits rank above body hits.
function search(home, query, limit) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const all = list(home);
  if (!words.length) return all.slice(0, limit || 20);
  const scored = [];
  for (const m of all) {
    const head = (m.name + " " + m.title + " " + m.tags.join(" ")).toLowerCase();
    const body = m.body.toLowerCase();
    let score = 0;
    let every = true;
    for (const w of words) {
      if (head.includes(w)) score += 3;
      else if (body.includes(w)) score += 1;
      else every = false;
    }
    if (every) scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score || b.m.updated_at - a.m.updated_at);
  return scored.slice(0, limit || 20).map((x) => x.m);
}

// The short list agents get when the server starts.
function index(memories, max) {
  const shown = memories.slice(0, max || 60);
  const lines = shown.map((m) => "- " + m.name + ": " + m.title + (m.tags.length ? " [" + m.tags.join(", ") + "]" : ""));
  if (memories.length > shown.length) lines.push("- ... and " + (memories.length - shown.length) + " more. Use memory_search.");
  return lines.join("\n");
}

module.exports = { list, get, save, update, remove, search, index, slug, findSecret, MAX_BODY };
