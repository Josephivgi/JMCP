"use strict";

// Instruction files (AGENTS.md, CLAUDE.md, GEMINI.md, QWEN.md) for the app and
// every installed agent. Only files with those names can be read or written,
// so the server never becomes a general file editor. A delete or overwrite
// first copies the old file into ~/.jmcp/instructions-trash so the app can
// restore it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const NAMES = ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", "GEMINI.md", "QWEN.md"];
const MAX_BYTES = 1024 * 1024;
const KEEP_TRASH = 300;

function userHome(home) {
  return home || os.homedir();
}

function dbHome(home) {
  if (home) return path.join(home, ".jmcp");
  return process.env.JMCP_HOME ? path.resolve(process.env.JMCP_HOME) : path.join(os.homedir(), ".jmcp");
}

function withDb(home, fn) {
  const dir = dbHome(home);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "instructions.db"));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;" +
        "CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS hidden_folders (path TEXT PRIMARY KEY, hidden_at INTEGER NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS trash (id TEXT PRIMARY KEY, path TEXT NOT NULL, reason TEXT NOT NULL CHECK (reason IN ('deleted', 'replaced')), by TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL);",
    );
    return fn(db);
  } finally {
    db.close();
  }
}

// Each agent's own global instruction file.
function agentFiles(home) {
  const h = userHome(home);
  const xdg = !home && process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : path.join(h, ".config");
  return [
    { agent: "Claude Code", file: path.join(h, ".claude", "CLAUDE.md") },
    { agent: "Codex", file: path.join(h, ".codex", "AGENTS.md") },
    { agent: "Factory Droid", file: path.join(h, ".factory", "AGENTS.md") },
    { agent: "OpenCode", file: path.join(xdg, "opencode", "AGENTS.md") },
    { agent: "Cursor", file: path.join(h, ".cursor", "AGENTS.md") },
    { agent: "Gemini CLI", file: path.join(h, ".gemini", "GEMINI.md") },
    { agent: "Qwen Code", file: path.join(h, ".qwen", "QWEN.md") },
    { agent: "Grok", file: path.join(h, ".grok", "AGENTS.md") },
  ];
}

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// An absolute path whose name is one of NAMES, or an error.
function checkPath(file) {
  if (typeof file !== "string" || !file.trim()) throw new Error("path must not be empty.");
  if (!path.isAbsolute(file.trim())) throw new Error("path must be absolute.");
  const full = path.resolve(file.trim());
  const name = NAMES.find((n) => samePath(n, path.basename(full)));
  if (!name) throw new Error("Only " + NAMES.join(", ") + " files can be managed. Got " + path.basename(full) + ".");
  return path.join(path.dirname(full), name);
}

function checkFolder(folder) {
  if (typeof folder !== "string" || !folder.trim()) throw new Error("folder must not be empty.");
  if (!path.isAbsolute(folder.trim())) throw new Error("folder must be absolute.");
  return path.resolve(folder.trim());
}

function stat(file) {
  try {
    const s = fs.statSync(file);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

function hash(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function info(file, extra) {
  const s = stat(file);
  return Object.assign({ path: file, name: path.basename(file), exists: Boolean(s), size: s ? s.size : 0, modified: s ? s.mtimeMs : 0 }, extra);
}

function folderFiles(folder) {
  let entries = [];
  try {
    entries = fs.readdirSync(folder);
  } catch {
    return [];
  }
  return NAMES.map((n) => entries.find((e) => samePath(e, n)) && path.join(folder, n)).filter((f) => f && stat(f));
}

function folders(home) {
  return withDb(home, (db) => db.prepare("SELECT path FROM folders ORDER BY added_at, path").all().map((r) => r.path));
}

function addFolder(home, folder) {
  folder = checkFolder(folder);
  let s;
  try {
    s = fs.statSync(folder);
  } catch {
    throw new Error("No folder at " + folder + ".");
  }
  if (!s.isDirectory()) throw new Error(folder + " is not a folder.");
  withDb(home, (db) => {
    if (!db.prepare("SELECT path FROM folders").all().some((r) => samePath(r.path, folder)))
      db.prepare("INSERT INTO folders (path, added_at) VALUES (?, ?)").run(folder, Date.now());
    for (const r of db.prepare("SELECT path FROM hidden_folders").all()) if (samePath(r.path, folder)) db.prepare("DELETE FROM hidden_folders WHERE path = ?").run(r.path);
  });
  return folder;
}

// Stop showing a folder: drop it from the saved list and hide it from
// detection. Its files stay.
function removeFolder(home, folder) {
  folder = checkFolder(folder);
  return withDb(home, (db) => {
    const row = db.prepare("SELECT path FROM folders").all().find((r) => samePath(r.path, folder));
    const removed = row ? db.prepare("DELETE FROM folders WHERE path = ?").run(row.path).changes > 0 : false;
    const hidden = db.prepare("SELECT path FROM hidden_folders").all().some((r) => samePath(r.path, folder));
    if (!hidden) db.prepare("INSERT INTO hidden_folders (path, hidden_at) VALUES (?, ?)").run(folder, Date.now());
    return removed || !hidden;
  });
}

function hiddenFolders(home) {
  return withDb(home, (db) => db.prepare("SELECT path FROM hidden_folders").all().map((r) => r.path));
}

// Project folders with instruction files that are not saved yet: folders
// agents have worked in, from their own history, plus the usual project
// folders. Temp, scratch and worktree folders are skipped.
const SKIP = /[\\/](AppData|\.ao|node_modules|\.git|\.cache|Temp|tmp|scratch[^\\/]*|worktrees?)([\\/]|$)/i;

function claudeProjects(h) {
  try {
    return Object.keys(JSON.parse(fs.readFileSync(path.join(h, ".claude.json"), "utf8")).projects || {});
  } catch {
    return [];
  }
}

// The working folder of the newest Codex sessions (first line of each file).
function codexProjects(h, max) {
  const root = path.join(h, ".codex", "sessions");
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? 1 : -1))) {
      if (files.length >= max) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) walk(p, depth - 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(p);
    }
  };
  walk(root, 3);
  const out = [];
  const buf = Buffer.alloc(4096);
  for (const f of files) {
    let fd;
    try {
      fd = fs.openSync(f, "r");
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString("utf8", 0, n));
      if (m) out.push(JSON.parse('"' + m[1] + '"'));
    } catch {
      /* next */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return out;
}

// Child folders of home and of common project roots.
function projectRoots(h) {
  const roots = [h, "Documents", "Desktop", "Projects", "projects", "dev", "code", "src", "repos", "source/repos", "GitHub", "Documents/GitHub", "Downloads/workspace"].map((r) => (r === h ? h : path.join(h, r)));
  const out = [];
  for (const r of roots) {
    let entries;
    try {
      entries = fs.readdirSync(r, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".")) out.push(path.join(r, e.name));
  }
  return out;
}

function detectFolders(home) {
  const h = userHome(home);
  const hidden = hiddenFolders(home);
  const saved = folders(home);
  const out = [];
  const consider = (p) => {
    if (typeof p !== "string" || !p || !path.isAbsolute(p)) return;
    const folder = path.resolve(p);
    // Judge only the part below home, so a home under a temp folder still works.
    const rel = path.relative(path.resolve(h), folder);
    if (SKIP.test(path.sep + (rel.startsWith("..") ? folder : rel))) return;
    if ([...out.map((f) => f.path), ...saved, ...hidden].some((f) => samePath(f, folder))) return;
    const files = folderFiles(folder).map((f) => info(f));
    if (!files.length) return;
    out.push({ path: folder, saved: false, detected: true, exists: true, files, modified: Math.max(...files.map((f) => f.modified)) });
  };
  consider(h);
  for (const p of claudeProjects(h)) consider(p);
  for (const p of codexProjects(h, 150)) consider(p);
  for (const p of projectRoots(h)) consider(p);
  // Newest edits first.
  return out.sort((a, b) => b.modified - a.modified);
}

// Every agent's global file (made or not), then each saved folder (and an
// extra folder, such as the agent's working folder) with the files it has.
function list(home, extraFolder) {
  const out = { agents: agentFiles(home).map((a) => info(a.file, { agent: a.agent })), folders: [] };
  const seen = [];
  const add = (folder, saved) => {
    if (seen.some((f) => samePath(f, folder))) return;
    seen.push(folder);
    out.folders.push({ path: folder, saved, exists: Boolean(fs.existsSync(folder)), files: folderFiles(folder).map((f) => info(f)) });
  };
  folders(home).forEach((f) => add(f, true));
  if (extraFolder) add(checkFolder(extraFolder), false);
  return out;
}

function read(file) {
  file = checkPath(file);
  const s = stat(file);
  if (!s) throw new Error("No file at " + file + ".");
  if (s.size > MAX_BYTES) throw new Error(file + " is larger than 1 MB.");
  const text = fs.readFileSync(file, "utf8");
  return info(file, { text, hash: hash(text) });
}

function trashDir(home) {
  return path.join(dbHome(home), "instructions-trash");
}

// Copy the file into the trash before it changes or goes away.
function keep(home, db, file, reason, by) {
  const id = crypto.randomUUID();
  const dir = trashDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, id + ".md"));
  db.prepare("INSERT INTO trash (id, path, reason, by, size, at) VALUES (?, ?, ?, ?, ?, ?)").run(id, file, reason, by, stat(file).size, Date.now());
  const old = db.prepare("SELECT id FROM trash ORDER BY at DESC, id LIMIT -1 OFFSET ?").all(KEEP_TRASH);
  for (const r of old) {
    fs.rmSync(path.join(dir, r.id + ".md"), { force: true });
    db.prepare("DELETE FROM trash WHERE id = ?").run(r.id);
  }
  return id;
}

// Write the whole file. expectedHash (from read) refuses the write when the
// file changed since it was read. Line endings follow the file being replaced.
function write(home, file, text, opts) {
  file = checkPath(file);
  if (typeof text !== "string") throw new Error("content must be a string.");
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("content is larger than 1 MB.");
  const by = (opts && opts.by) || "app";
  return withDb(home, (db) => {
    const before = stat(file) ? fs.readFileSync(file, "utf8") : null;
    if (opts && opts.expectedHash !== undefined && opts.expectedHash !== (before === null ? "" : hash(before)))
      throw new Error(path.basename(file) + " changed on disk since it was opened. Reload it before saving.");
    if (before !== null && before.includes("\r\n") && !text.includes("\r")) text = text.replace(/\n/g, "\r\n");
    if (before === text) return info(file, { hash: hash(text), changed: false, created: false });
    if (before !== null) keep(home, db, file, "replaced", by);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".jmcp-tmp";
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return info(file, { hash: hash(text), changed: true, created: before === null });
  });
}

// Move the file into the trash. The app can restore it.
function remove(home, file, opts) {
  file = checkPath(file);
  if (!stat(file)) throw new Error("No file at " + file + ".");
  const by = (opts && opts.by) || "app";
  return withDb(home, (db) => {
    const id = keep(home, db, file, "deleted", by);
    fs.rmSync(file);
    return { path: file, trashId: id };
  });
}

function trash(home) {
  return withDb(home, (db) => db.prepare("SELECT * FROM trash ORDER BY at DESC, id").all().map((r) => Object.assign({}, r)));
}

function trashText(home, id) {
  const row = withDb(home, (db) => db.prepare("SELECT * FROM trash WHERE id = ?").get(String(id)));
  if (!row) throw new Error("That copy is no longer in the trash.");
  return fs.readFileSync(path.join(trashDir(home), row.id + ".md"), "utf8");
}

// Put a trashed copy back where it was. The current file, if any, goes to
// the trash first, so a restore can be undone too.
function restore(home, id) {
  const row = withDb(home, (db) => db.prepare("SELECT * FROM trash WHERE id = ?").get(String(id)));
  if (!row) throw new Error("That copy is no longer in the trash.");
  const text = trashText(home, row.id);
  const result = write(home, row.path, text, { by: "restore" });
  forget(home, row.id);
  return result;
}

function forget(home, id) {
  return withDb(home, (db) => {
    fs.rmSync(path.join(trashDir(home), String(id) + ".md"), { force: true });
    return db.prepare("DELETE FROM trash WHERE id = ?").run(String(id)).changes > 0;
  });
}

module.exports = { NAMES, agentFiles, checkPath, folders, addFolder, removeFolder, detectFolders, hiddenFolders, list, read, write, remove, trash, trashText, restore, forget, hash };
