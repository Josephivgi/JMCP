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
        "CREATE TABLE IF NOT EXISTS trash (id TEXT PRIMARY KEY, path TEXT NOT NULL, reason TEXT NOT NULL CHECK (reason IN ('deleted', 'replaced')), by TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
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
    { id: "claude-code", agent: "Claude Code", file: path.join(h, ".claude", "CLAUDE.md") },
    { id: "codex", agent: "Codex", file: path.join(h, ".codex", "AGENTS.md") },
    { id: "factory-droid", agent: "Factory Droid", file: path.join(h, ".factory", "AGENTS.md") },
    { id: "opencode", agent: "OpenCode", file: path.join(xdg, "opencode", "AGENTS.md") },
    { id: "cursor", agent: "Cursor", file: path.join(h, ".cursor", "AGENTS.md") },
    { id: "gemini", agent: "Gemini CLI", file: path.join(h, ".gemini", "GEMINI.md") },
    { id: "qwen", agent: "Qwen Code", file: path.join(h, ".qwen", "QWEN.md") },
    { id: "grok", agent: "Grok", file: path.join(h, ".grok", "AGENTS.md") },
  ];
}

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Claude Code also reads every .md file in ~/.claude/rules.
function rulesDir(home) {
  return path.join(userHome(home), ".claude", "rules");
}

function rulesFiles(home) {
  const dir = rulesDir(home);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && /\.md$/i.test(e.name)).map((e) => path.join(dir, e.name)).sort();
}

// The user's master instructions: one file, edited in the app, that the
// jmcp-instructions server gives every agent as instructions it must follow.
function masterPath(home) {
  return path.join(dbHome(home), "master-instructions.md");
}

function isMaster(file, home) {
  return samePath(path.resolve(file), masterPath(home));
}

// The master text, or "" when it is not set.
function master(home) {
  const file = masterPath(home);
  const s = stat(file);
  if (!s || s.size > MAX_BYTES) return "";
  return fs.readFileSync(file, "utf8").trim();
}

// An absolute path whose name is one of NAMES, a .md file directly in
// ~/.claude/rules, or the master instructions file, or an error.
function checkPath(file, home) {
  if (typeof file !== "string" || !file.trim()) throw new Error("path must not be empty.");
  if (!path.isAbsolute(file.trim())) throw new Error("path must be absolute.");
  const full = path.resolve(file.trim());
  if (isMaster(full, home)) return masterPath(home);
  const name = NAMES.find((n) => samePath(n, path.basename(full)));
  if (name) return path.join(path.dirname(full), name);
  if (/^[^\\/]+\.md$/i.test(path.basename(full)) && samePath(path.dirname(full), rulesDir(home))) {
    // The rules folder may not exist yet; check the nearest folder that does,
    // so a linked ~/.claude cannot send a new rules folder somewhere else.
    let p = rulesDir(home);
    while (!fs.existsSync(p) && path.dirname(p) !== p) p = path.dirname(p);
    const base = userHome(home);
    const expected = path.join(real(base), path.relative(base, p));
    if (!samePath(real(p), expected)) throw new Error(p + " is a link to another folder, so JMCP will not manage files through it.");
    return full;
  }
  throw new Error("Only " + NAMES.join(", ") + " files, or .md files in " + rulesDir(home) + ", can be managed. Got " + path.basename(full) + ".");
}

// The real path, following links, or the path itself when it does not exist.
function real(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

// A link named like an instruction file must point at one too, so read and
// the trash never pick up some other file through it.
function checkLink(file, home) {
  let l;
  try {
    l = fs.lstatSync(file);
  } catch {
    return;
  }
  // Hard links are allowed: people link CLAUDE.md and AGENTS.md that way, a
  // write replaces the name with a new file (never writes through it), and
  // making the link already took access to the other file.
  if (!l.isSymbolicLink()) return;
  const target = real(file);
  try {
    checkPath(target, home);
  } catch {
    throw new Error(file + " is a link to " + target + ", which is not an instruction file.");
  }
}

// One writer at a time across the app and every agent: the check, the trash
// copy and the replace happen inside one immediate transaction. Files are
// only deleted once it commits (db.afterCommit); backups made in a
// transaction that rolls back are removed again (db.onRollback).
function locked(home, fn) {
  return withDb(home, (db) => {
    db.afterCommit = [];
    db.onRollback = [];
    db.exec("BEGIN IMMEDIATE");
    let out;
    try {
      out = fn(db);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      for (const f of db.onRollback) fs.rmSync(f, { force: true });
      throw e;
    }
    for (const f of db.afterCommit) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* a locked old backup; the next prune removes it */
      }
    }
    return out;
  });
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
  const out = { master: info(masterPath(home)), agents: agentFiles(home).map((a) => info(a.file, { agent: a.agent })), rules: rulesFiles(home).map((f) => info(f)), folders: [] };
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

function read(file, home) {
  file = checkPath(file, home);
  checkLink(file, home);
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
  const copy = path.join(dir, id + ".md");
  fs.copyFileSync(file, copy);
  if (db.onRollback) db.onRollback.push(copy);
  db.prepare("INSERT INTO trash (id, path, reason, by, size, at) VALUES (?, ?, ?, ?, ?, ?)").run(id, file, reason, by, stat(file).size, Date.now());
  const old = db.prepare("SELECT id FROM trash ORDER BY at DESC, id LIMIT -1 OFFSET ?").all(KEEP_TRASH);
  for (const r of old) {
    db.prepare("DELETE FROM trash WHERE id = ?").run(r.id);
    const f = path.join(dir, r.id + ".md");
    if (db.afterCommit) db.afterCommit.push(f);
    else fs.rmSync(f, { force: true });
  }
  return id;
}

// Only the user changes the master instructions, in the app.
function notAgentOnMaster(file, home, by) {
  if (by === "agent" && isMaster(file, home)) throw new Error("The master instructions are set by the user in the JMCP app. Agents can read them but not change or delete them.");
}

// Write the whole file. expectedHash (from read) refuses the write when the
// file changed since it was read. Line endings follow the file being replaced.
function write(home, file, text, opts) {
  file = checkPath(file, home);
  checkLink(file, home);
  if (typeof text !== "string") throw new Error("content must be a string.");
  // A restore may bring back a file that was already over the limit.
  const limit = opts && opts.restoring ? Infinity : MAX_BYTES;
  if (Buffer.byteLength(text) > limit) throw new Error("content is larger than 1 MB.");
  const by = (opts && opts.by) || "app";
  notAgentOnMaster(file, home, by);
  const r = locked(home, (db) => {
    const before = stat(file) ? fs.readFileSync(file, "utf8") : null;
    const expected = opts && opts.expectedHash;
    if (expected === "" && before !== null)
      throw new Error(path.basename(file) + " already exists at " + file + ". Read it first and pass its hash.");
    if (expected !== undefined && expected !== "" && expected !== (before === null ? "" : hash(before)))
      throw new Error(before === null ? file + " no longer exists. Write it again with an empty hash to create it." : path.basename(file) + " changed on disk since it was opened. Reload it before saving.");
    if (before !== null && before.includes("\r\n") && !text.includes("\r")) text = text.replace(/\n/g, "\r\n");
    if (Buffer.byteLength(text) > limit) throw new Error("content is larger than 1 MB once its line endings match the file.");
    if (before === text) return info(file, { hash: hash(text), changed: false, created: false });
    if (before !== null) keep(home, db, file, "replaced", by);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A fresh name each time, created new (wx), so nothing already there is
    // ever opened or written through.
    const tmp = file + "." + crypto.randomUUID().slice(0, 8) + ".jmcp-tmp";
    try {
      fs.writeFileSync(tmp, text, { flag: "wx" });
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    return info(file, { hash: hash(text), changed: true, created: before === null });
  });
  return afterMaster(home, file, r);
}

// A change to the master instructions updates the line in every agent file.
function afterMaster(home, file, result) {
  if (isMaster(file, home)) result.pointers = syncPointers(home);
  return result;
}

// Move the file into the trash. The app can restore it.
function remove(home, file, opts) {
  file = checkPath(file, home);
  checkLink(file, home);
  const by = (opts && opts.by) || "app";
  notAgentOnMaster(file, home, by);
  if (!stat(file)) throw new Error("No file at " + file + ".");
  const r = locked(home, (db) => {
    if (!stat(file)) throw new Error("No file at " + file + ".");
    const id = keep(home, db, file, "deleted", by);
    fs.rmSync(file);
    return { path: file, trashId: id };
  });
  return afterMaster(home, file, r);
}

// While master instructions are set, each agent's global file starts with
// this line, because some agents (Factory Droid) never show MCP server
// instructions and only call the tool when a file tells them to. JMCP puts
// the line back when it goes missing and takes it out when the master
// instructions are deleted. The marker finds it again.
const POINTER_MARK = "<!-- JMCP master instructions";
const POINTER = "Before your first reply in every session, call the master_instructions tool of the jmcp-instructions MCP server and follow what it returns. " + POINTER_MARK + ": JMCP keeps this line here while they are set. -->";

function pointerLines(text) {
  return text.split("\n").filter((l) => l.includes(POINTER_MARK));
}

// Whether the file already has the line exactly once (want) or not at all.
function pointerOk(text, want) {
  const lines = pointerLines(text);
  return want ? lines.length === 1 && lines[0].replace(/\r$/, "") === POINTER : lines.length === 0;
}

function withoutPointer(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(POINTER_MARK)) {
      out.push(lines[i]);
      continue;
    }
    // Also drop the blank line JMCP put after it at the top.
    if (!out.length && lines[i + 1] !== undefined && !lines[i + 1].trim()) i++;
  }
  return out.join("\n");
}

// Add or remove the line in one file. Changes happen in place, so a file
// that is a link (CLAUDE.md to AGENTS.md) stays one. The old version goes to
// the trash first. Returns true when the file changed.
function pointerFile(home, file, want) {
  const current = () => {
    const s = stat(file);
    if (s && s.size > MAX_BYTES) return undefined;
    return s ? fs.readFileSync(file, "utf8") : null;
  };
  // The JMCP agent guide already tells the agent to call master_instructions.
  const wantIn = (text) => want && !(text && text.includes(GUIDE_MARK));
  const done = (before) => before === undefined || (before === null ? !want : pointerOk(before, wantIn(before)));
  // Most session starts change nothing; check before taking the lock.
  if (done(current())) return false;
  checkLink(file, home);
  return locked(home, (db) => {
    const before = current();
    if (done(before)) return false;
    want = wantIn(before);
    const eol = before && before.includes("\r\n") ? "\r\n" : "\n";
    const rest = before === null ? "" : withoutPointer(before);
    if (before !== null) keep(home, db, file, "replaced", "jmcp");
    if (!want && !rest.trim()) {
      // The file only held the line.
      fs.rmSync(file);
      return true;
    }
    fs.writeFileSync(file, want ? POINTER + eol + (rest.trim() ? eol + rest : "") : rest);
    return true;
  });
}

// Bring every agent's global file in line with the master instructions.
// Agents whose folder is not on this computer are skipped. addOnly never
// removes lines (agent sessions use it, so a server started on a scratch
// JMCP home cannot take them out).
function syncPointers(home, opts) {
  const want = master(home) !== "";
  const out = { changed: [], errors: [] };
  if (!want && opts && opts.addOnly) return out;
  for (const a of agentFiles(home)) {
    if (!fs.existsSync(path.dirname(a.file))) continue;
    try {
      if (pointerFile(home, a.file, want)) out.changed.push(a.file);
    } catch (e) {
      out.errors.push({ path: a.file, error: String(e.message || e) });
    }
  }
  return out;
}

// The JMCP agent guide: a section the user can turn on in the app. Agents
// do not always look at their MCP servers by themselves, so the section at
// the top of each agent's global file says which JMCP servers to use, and
// what to do when they are not connected in the session. JMCP rewrites it
// when it changes and takes it out when it is turned off. While it is there,
// it stands in for the master instructions line.
const GUIDE_MARK = "<!-- JMCP agent guide";
const GUIDE_END = "<!-- end of JMCP agent guide -->";
const GUIDE_SERVERS = ["instructions", "rules", "skills", "memory"];

function guideOn(home) {
  return withDb(home, (db) => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'guide'").get();
    return Boolean(row && row.value === "on");
  });
}

function setGuideOn(home, on) {
  withDb(home, (db) => db.prepare("INSERT INTO settings (key, value) VALUES ('guide', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? "on" : "off"));
}

// The section for one agent. connect.cli is the JMCP command line, given
// when Node is on the PATH so the agent can run it.
function guideText(a, connect) {
  const lines = [
    GUIDE_MARK + ": JMCP keeps this section up to date. Turn it off on the Instructions page of the JMCP app. -->",
    "## JMCP",
    "",
    "The user runs JMCP, which gives you these MCP servers. Use them:",
    "",
    "- jmcp-instructions: before your first reply in every session, and at the start of each new task, call its master_instructions tool and follow what it returns. Finding or loading the tool is not enough; call it before you answer, even for a short question.",
    "- jmcp-rules: the user's rules. Follow them in everything you do.",
    "- jmcp-skills: the user's skills. When a task matches a skill's description, load it with skill_read and follow it.",
    "- jmcp-memory: memory shared by all of the user's agents. Search it before work that may depend on the user's preferences or past decisions, and save what a future session should know.",
    "- jmcp-subagents, jmcp-health and jmcp-browser, when installed: other coding agents as subagents, health checks of this computer, and a hidden browser.",
    "",
    "Some agents load MCP servers a few seconds after the session starts, so look for the jmcp- tools again before deciding they are missing. If they are still missing, JMCP is not connected in this session. Say so at the start of your reply and offer to connect it." +
      (connect && connect.cli ? " With the user's OK, run:" : " The user connects it in the JMCP app: open JMCP servers and install jmcp-instructions, jmcp-rules, jmcp-skills and jmcp-memory for " + a.agent + "."),
  ];
  if (connect && connect.cli) {
    lines.push("", "```");
    for (const s of GUIDE_SERVERS) lines.push('node "' + connect.cli + '" install ' + s + " " + a.id);
    lines.push("```", "", "The user can also do it in the JMCP app, on the JMCP servers page.");
  }
  lines.push("New servers load when a session starts, so ask the user to start a new session afterwards.", GUIDE_END);
  return lines.join("\n");
}

// The file without the section, and the blank line JMCP put after it.
function withoutGuide(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.includes(GUIDE_MARK));
  if (start < 0) return text;
  let end = lines.findIndex((l, i) => i > start && l.includes(GUIDE_END));
  // Someone took out the end marker: only the first line is surely JMCP's.
  if (end < 0) end = start;
  if (lines[end + 1] !== undefined && !lines[end + 1].trim()) end++;
  lines.splice(start, end - start + 1);
  return lines.join("\n");
}

function guideOk(text, block) {
  const lf = text.replace(/\r\n/g, "\n");
  if (!block) return !lf.includes(GUIDE_MARK);
  return lf.split(GUIDE_MARK).length === 2 && lf.includes(block);
}

// Put the section in one file (block) or take it out (null). Like the master
// instructions line: in place, the old version in the trash first.
function guideFile(home, file, block) {
  const current = () => {
    const s = stat(file);
    if (s && s.size > MAX_BYTES) return undefined;
    return s ? fs.readFileSync(file, "utf8") : null;
  };
  const done = (before) => before === undefined || (before === null ? !block : guideOk(before, block));
  if (done(current())) return false;
  checkLink(file, home);
  return locked(home, (db) => {
    const before = current();
    if (done(before)) return false;
    const eol = before && before.includes("\r\n") ? "\r\n" : "\n";
    let rest = before === null ? "" : withoutGuide(before.replace(/\r\n/g, "\n"));
    // The section replaces the master instructions line.
    if (block) rest = withoutPointer(rest);
    if (before !== null) keep(home, db, file, "replaced", "jmcp");
    if (!block && !rest.trim()) {
      fs.rmSync(file);
      return true;
    }
    const text = block ? block + "\n" + (rest.trim() ? "\n" + rest : "") : rest;
    fs.writeFileSync(file, eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);
    return true;
  });
}

// Bring every agent's global file in line with the guide setting, then the
// master instructions line, which comes back where the section went away.
// on (true or false) also saves the setting.
function syncGuide(home, opts) {
  opts = opts || {};
  if (typeof opts.on === "boolean") setGuideOn(home, opts.on);
  const on = guideOn(home);
  const out = { on, changed: [], errors: [] };
  for (const a of agentFiles(home)) {
    if (!fs.existsSync(path.dirname(a.file))) continue;
    try {
      if (guideFile(home, a.file, on ? guideText(a, opts.connect) : null)) out.changed.push(a.file);
    } catch (e) {
      out.errors.push({ path: a.file, error: String(e.message || e) });
    }
  }
  const p = syncPointers(home);
  for (const f of p.changed) if (!out.changed.includes(f)) out.changed.push(f);
  out.errors.push(...p.errors);
  return out;
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
  const result = write(home, row.path, text, { by: "restore", restoring: true });
  forget(home, row.id);
  return result;
}

// Drop a copy from the trash. Only ids that are in the trash table, so a
// made-up id can never name a file outside it.
function forget(home, id) {
  return withDb(home, (db) => {
    const row = db.prepare("SELECT id FROM trash WHERE id = ?").get(String(id));
    if (!row || !/^[0-9a-f-]{36}$/i.test(row.id)) return false;
    fs.rmSync(path.join(trashDir(home), row.id + ".md"), { force: true });
    return db.prepare("DELETE FROM trash WHERE id = ?").run(row.id).changes > 0;
  });
}

module.exports = { NAMES, POINTER, masterPath, master, syncPointers, guideOn, guideText, syncGuide, agentFiles, rulesDir, rulesFiles, checkPath, folders, addFolder, removeFolder, detectFolders, hiddenFolders, list, read, write, remove, trash, trashText, restore, forget, hash };
