"use strict";

// One skills library for the app and every installed agent. A skill is a
// named set of instructions (the SKILL.md format: name, description, body)
// that an agent loads when a task matches its description. Skills are made
// in the JMCP app, imported from agents' skill folders, or saved by agents
// with skill_save.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const MAX_BODY = 200000;

function dbHome(home) {
  if (home) return path.join(home, ".jmcp");
  return process.env.JMCP_HOME ? path.resolve(process.env.JMCP_HOME) : path.join(os.homedir(), ".jmcp");
}

function withDb(home, fn) {
  const dir = dbHome(home);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "skills.db"));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;" +
        "CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, body TEXT NOT NULL, enabled INTEGER NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    );
    return fn(db);
  } finally {
    db.close();
  }
}

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

function descriptionValue(d) {
  if (typeof d !== "string" || !d.trim()) throw new Error("description must not be empty. Agents use it to decide when to load the skill.");
  return d.trim().slice(0, 2000);
}

function bodyValue(body) {
  if (typeof body !== "string" || !body.trim()) throw new Error("instructions must not be empty.");
  if (body.length > MAX_BODY) throw new Error("instructions are longer than " + MAX_BODY + " characters.");
  return body.trim();
}

function row(r) {
  return r ? { ...r, enabled: Boolean(r.enabled) } : null;
}

function list(home) {
  return withDb(home, (db) => db.prepare("SELECT * FROM skills ORDER BY name").all().map(row));
}

// One skill. Agents name skills, so opts.byName looks at names only; the
// app passes ids. Without it: by id, else by name, never both.
function get(home, ref, opts) {
  return withDb(home, (db) => {
    const byName = () => db.prepare("SELECT * FROM skills WHERE name = ?").get(slug(ref));
    return row(opts && opts.byName ? byName() : db.prepare("SELECT * FROM skills WHERE id = ?").get(String(ref)) || byName());
  });
}

function add(home, { name, description, body, origin } = {}) {
  const key = nameValue(name);
  description = descriptionValue(description);
  body = bodyValue(body);
  return withDb(home, (db) => {
    if (db.prepare("SELECT id FROM skills WHERE name = ?").get(key)) throw new Error("A skill named " + key + " already exists.");
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare("INSERT INTO skills (id, name, description, body, enabled, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)").run(id, key, description, body, String(origin || ""), now, now);
    return row(db.prepare("SELECT * FROM skills WHERE id = ?").get(id));
  });
}

function update(home, id, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("patch must be an object.");
  const changes = {};
  if (Object.hasOwn(patch, "name")) changes.name = nameValue(patch.name);
  if (Object.hasOwn(patch, "description")) changes.description = descriptionValue(patch.description);
  if (Object.hasOwn(patch, "body")) changes.body = bodyValue(patch.body);
  if (Object.hasOwn(patch, "enabled")) {
    if (typeof patch.enabled !== "boolean") throw new Error("enabled must be a boolean.");
    changes.enabled = Number(patch.enabled);
  }
  return withDb(home, (db) => {
    if (!db.prepare("SELECT id FROM skills WHERE id = ?").get(id)) return null;
    if (changes.name && db.prepare("SELECT id FROM skills WHERE name = ? AND id != ?").get(changes.name, id)) throw new Error("A skill named " + changes.name + " already exists.");
    const keys = Object.keys(changes);
    if (keys.length) db.prepare("UPDATE skills SET " + keys.map((k) => k + " = ?").join(", ") + ", updated_at = ? WHERE id = ?").run(...keys.map((k) => changes[k]), Date.now(), id);
    return row(db.prepare("SELECT * FROM skills WHERE id = ?").get(id));
  });
}

// Add a skill, or replace the one with that name, in one transaction so two
// agents saving the same name at once cannot collide. Skills imported from a
// SKILL.md file are not replaced. Returns { skill, created }.
function save(home, { name, description, body } = {}) {
  const key = nameValue(name);
  description = descriptionValue(description);
  body = bodyValue(body);
  return withDb(home, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const old = db.prepare("SELECT * FROM skills WHERE name = ?").get(key);
      if (old && old.origin) throw new Error("Not saved: " + key + " comes from " + old.origin + ". Edit that SKILL.md file; JMCP picks up the change on the next import.");
      const now = Date.now();
      let id = old && old.id;
      if (old) db.prepare("UPDATE skills SET description = ?, body = ?, updated_at = ? WHERE id = ?").run(description, body, now, id);
      else {
        id = crypto.randomUUID();
        db.prepare("INSERT INTO skills (id, name, description, body, enabled, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 1, '', ?, ?)").run(id, key, description, body, now, now);
      }
      const skill = row(db.prepare("SELECT * FROM skills WHERE id = ?").get(id));
      db.exec("COMMIT");
      return { skill, created: !old };
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  });
}

function remove(home, id) {
  return withDb(home, (db) => db.prepare("DELETE FROM skills WHERE id = ?").run(String(id)).changes > 0);
}

function active(home) {
  return list(home).filter((s) => s.enabled);
}

// ---- SKILL.md files ----

function unquote(v) {
  v = v.trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

// The top-level keys of YAML front matter: plain, quoted, and | or > blocks.
function parseSkillMd(text) {
  const src = String(text).replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) return { meta: {}, body: src.trim() };
  const meta = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2];
    if (/^[|>][+-]?$/.test(value.trim())) {
      const fold = value.trim()[0] === ">";
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
      value = block.join(fold ? " " : "\n").trim();
    } else {
      // Plain values may continue on indented lines.
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s+-/.test(lines[i + 1])) value += " " + lines[++i].trim();
      value = unquote(value);
    }
    meta[kv[1]] = value;
  }
  return { meta, body: m[2].trim() };
}

function readSkillFile(file) {
  const { meta, body } = parseSkillMd(fs.readFileSync(file, "utf8"));
  const dir = path.dirname(file);
  return { name: slug(meta.name || path.basename(dir)), description: String(meta.description || "").trim(), body, folder: dir, file };
}

// Skill folders are often links to a shared copy.
function isDir(dir, e) {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(dir, e.name)).isDirectory();
  } catch {
    return false;
  }
}

// SKILL.md files under each root, up to three folders deep.
function findSkillFiles(roots) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      out.push(path.join(dir, "SKILL.md"));
      return;
    }
    if (depth <= 0) return;
    for (const e of entries) if (isDir(dir, e) && e.name !== "node_modules" && e.name !== ".git") walk(path.join(dir, e.name), depth - 1);
  };
  for (const r of roots) walk(r, 3);
  return out;
}

// Import SKILL.md files. A name that is already in the library is updated
// only when it came from the same file; otherwise it is skipped.
function importFiles(home, files) {
  const results = [];
  for (const file of files) {
    try {
      const s = readSkillFile(file);
      if (!s.description) throw new Error("SKILL.md has no description.");
      const old = get(home, s.name, { byName: true });
      if (old && old.origin !== s.file) {
        results.push({ ok: false, file, name: s.name, error: "A skill named " + s.name + " is already in the library." });
        continue;
      }
      if (old) {
        update(home, old.id, { description: s.description, body: s.body || s.description });
        results.push({ ok: true, file, name: s.name, updated: true });
      } else {
        add(home, { name: s.name, description: s.description, body: s.body || s.description, origin: s.file });
        results.push({ ok: true, file, name: s.name, updated: false });
      }
    } catch (e) {
      results.push({ ok: false, file, name: slug(path.basename(path.dirname(file))), error: String(e.message || e) });
    }
  }
  return results;
}

// Files next to an imported SKILL.md (scripts, references) the agent can open.
function supportFiles(skill) {
  if (!skill.origin) return [];
  const dir = path.dirname(skill.origin);
  const out = [];
  const walk = (d, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth > 0) walk(p, depth - 1);
      else if (e.isFile() && p !== skill.origin) out.push(p);
      if (out.length >= 40) return;
    }
  };
  walk(dir, 2);
  return out;
}

// The list agents get: one line per skill. max caps how many are shown, so
// a large library cannot flood an agent's context.
function index(skills, max, descMax) {
  const most = descMax || 400;
  const shown = skills.slice(0, max || 200);
  const lines = shown.map((s) => {
    const d = s.description.replace(/\s+/g, " ");
    return "- " + s.name + ": " + (d.length > most ? d.slice(0, most - 3) + "..." : d);
  });
  if (skills.length > shown.length) lines.push("- ... and " + (skills.length - shown.length) + " more. Call skills_list with query to search them all.");
  return lines.join("\n");
}

module.exports = { list, get, add, update, save, remove, active, parseSkillMd, readSkillFile, findSkillFiles, importFiles, supportFiles, index, slug };
