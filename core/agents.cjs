"use strict";

// Every coding agent JMCP manages, and how each one stores its MCP servers.
// Reading returns one normal shape per server:
//   { name, transport: "stdio"|"http"|"sse", command, args, env, url, enabled, file }
// Writing edits the agent's own config file in place: JSON and JSONC files
// through jsonc-parser (comments and formatting kept), TOML files by
// replacing just that server's [mcp_servers.<name>] tables. Every write
// keeps a .jmcp-backup copy of the file as it was before JMCP's first change.
//
// `home` can point at a scratch folder so tests never touch real configs.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const jsonc = require("jsonc-parser");
const TOML = require("smol-toml");

function dirs(home) {
  const h = home || os.homedir();
  const custom = Boolean(home);
  const appData = !custom && process.env.APPDATA ? process.env.APPDATA : path.join(h, "AppData", "Roaming");
  const xdg = !custom && process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : path.join(h, ".config");
  return { home: h, appData, xdg, win: process.platform === "win32" };
}

// ---- File helpers ----

// null when the file is not there; any other read failure throws, so a
// locked or unreadable config is reported instead of treated as empty.
function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return null;
    throw e;
  }
}

function readError(file, e) {
  return "Could not read " + path.basename(file) + " (" + (e.code || String(e.message || e).split("\n")[0]) + ").";
}

function backup(file) {
  const b = file + ".jmcp-backup";
  if (fs.existsSync(file) && !fs.existsSync(b)) fs.copyFileSync(file, b);
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  const tmp = file + ".jmcp-tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  let text;
  try {
    text = readText(file);
  } catch (e) {
    return { exists: true, data: {}, error: readError(file, e) };
  }
  if (text == null) return { exists: false, data: {} };
  const errors = [];
  const data = jsonc.parse(text, errors, { allowTrailingComma: true });
  if (errors.length || data === undefined || typeof data !== "object") return { exists: true, data: {}, error: "Could not read " + path.basename(file) + " (not valid JSON)." };
  return { exists: true, data: data || {} };
}

function editJson(file, keyPath, value) {
  const text = readText(file);
  const base = text == null || !text.trim() ? "{}" : text;
  const eol = base.includes("\r\n") ? "\r\n" : "\n";
  const edits = jsonc.modify(base, keyPath, value, { formattingOptions: { insertSpaces: true, tabSize: detectIndent(base), eol } });
  writeText(file, jsonc.applyEdits(base, edits));
}

function detectIndent(text) {
  const m = text.match(/\n( +)"/);
  return m ? Math.min(8, m[1].length) : 2;
}

// TOML: [mcp_servers.<name>] plus its sub-tables ([mcp_servers.<name>.env]).
function tomlKey(name) {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

function tomlValue(v) {
  if (Array.isArray(v)) return "[" + v.map(tomlValue).join(", ") + "]";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(String(v));
}

// A table header line as { array, parts }: [mcp_servers."my server"] gives
// parts ["mcp_servers", "my server"]. Quoted keys may hold dots, spaces and
// brackets. null when the line is not a header.
function tomlHeader(line) {
  const open = /^\s*(\[\[?)/.exec(line);
  if (!open) return null;
  const array = open[1] === "[[";
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*/y;
  re.lastIndex = open[0].length;
  const parts = [];
  for (;;) {
    const m = re.exec(line);
    if (!m) return null;
    let part = m[3];
    if (m[2] != null) part = m[2];
    if (m[1] != null) {
      try {
        part = JSON.parse('"' + m[1] + '"');
      } catch {
        part = m[1];
      }
    }
    parts.push(part);
    if (line[re.lastIndex] !== ".") break;
    re.lastIndex++;
  }
  const close = array ? "]]" : "]";
  if (!line.startsWith(close, re.lastIndex)) return null;
  if (!/^\s*(#.*)?$/.test(line.slice(re.lastIndex + close.length))) return null;
  return { array, parts };
}

// Whether a multi-line string (""" or ''') is still open after this line.
// open is the delimiter open before the line, or null.
function tomlMultiline(line, open) {
  let i = 0;
  while (i < line.length) {
    if (open) {
      // In a basic """ string a backslash escapes the next character, so
      // \""" does not close it. Literal ''' strings have no escapes.
      if (open === '"""' && line[i] === "\\") {
        i += 2;
        continue;
      }
      if (line.startsWith(open, i)) {
        i += 3;
        open = null;
      } else i++;
      continue;
    }
    const c = line[i];
    if (c === "#") return null;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      open = line.slice(i, i + 3);
      i += 3;
    } else if (c === '"') {
      i++;
      while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "'") {
      const at = line.indexOf("'", i + 1);
      i = at < 0 ? line.length : at + 1;
    } else i++;
  }
  return open;
}

// Drops [mcp_servers.<name>] and its sub-tables. Any other header, including
// an array table like [[skills.config]], ends the dropped block. Lines inside
// multi-line strings are never read as headers.
function removeTomlServer(text, name) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  let open = null;
  for (const line of lines) {
    const h = open ? null : tomlHeader(line);
    if (h) skipping = !h.array && h.parts[0] === "mcp_servers" && h.parts[1] === name;
    open = tomlMultiline(line, open);
    if (!skipping) out.push(line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n") + (out.length ? "\n" : "");
}

function tomlServerBlock(name, entry) {
  const head = "mcp_servers." + tomlKey(name);
  const lines = ["[" + head + "]"];
  const env = entry.env || {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === "env" || v === undefined || v === null) continue;
    lines.push(tomlKey(k) + " = " + tomlValue(v));
  }
  if (Object.keys(env).length) {
    lines.push("", "[" + head + ".env]");
    for (const [k, v] of Object.entries(env)) lines.push(tomlKey(k) + " = " + tomlValue(v));
  }
  return lines.join("\n") + "\n";
}

function readToml(file) {
  let text;
  try {
    text = readText(file);
  } catch (e) {
    return { exists: true, data: {}, error: readError(file, e) };
  }
  if (text == null) return { exists: false, data: {} };
  try {
    return { exists: true, data: TOML.parse(text) };
  } catch (e) {
    return { exists: true, data: {}, error: "Could not read " + path.basename(file) + " (" + String(e.message).split("\n")[0] + ")." };
  }
}

// Never write a TOML file that no longer parses: the agent would lose every
// setting in it, not only the server.
function writeToml(file, before, after) {
  let ok = true;
  try {
    TOML.parse(before);
  } catch {
    ok = false;
  }
  if (ok) {
    try {
      TOML.parse(after);
    } catch (e) {
      throw new Error("JMCP did not change " + path.basename(file) + ": the edit would break it (" + String(e.message).split("\n")[0] + ").");
    }
  }
  writeText(file, after);
}

function setTomlServer(file, name, entry) {
  const text = readText(file) || "";
  let out = removeTomlServer(text, name);
  out = (out.trim() ? out.replace(/\s*$/, "\n\n") : "") + tomlServerBlock(name, entry);
  writeToml(file, text, out);
}

function deleteTomlServer(file, name) {
  const text = readText(file);
  if (text != null) writeToml(file, text, removeTomlServer(text, name));
}

// ---- Normal shape ----

function norm(name, raw, file, extra) {
  const r = raw || {};
  const url = r.url || r.httpUrl || r.serverUrl || "";
  let command = r.command;
  let args = Array.isArray(r.args) ? r.args : [];
  if (Array.isArray(command)) {
    args = command.slice(1);
    command = command[0];
  }
  const t = String(r.type || r.transport || "").toLowerCase();
  const transport = url ? (t === "sse" ? "sse" : "http") : "stdio";
  const enabled = !(r.disabled === true || r.enabled === false);
  return Object.assign({ name, transport, command: command || "", args: args.map(String), env: r.env || r.environment || {}, url, enabled, file }, extra || {});
}

// ---- Agents ----
//
// Each agent: id, name, detect(d) -> bool, files(d) -> [{file, kind}], read(d)
// -> {servers, errors}, write(d, name, def), remove(d, name). def is the
// server definition JMCP installs: {command, args, env} or {url}.

// Servers under o.key. With o.nested (OpenCode 2: mcp.servers.<name>), the
// nested map and the older flat one (mcp.<name>) are both read.
function serverMap(data, o) {
  const top = (data && data[o.key]) || {};
  if (!o.nested) return top;
  const inner = top[o.nested] && typeof top[o.nested] === "object" && !top[o.nested].command && !top[o.nested].url ? top[o.nested] : null;
  const flat = Object.fromEntries(Object.entries(top).filter(([k]) => !(inner && k === o.nested)));
  return Object.assign({}, flat, inner || {});
}

// Where a server goes: the nested map when it already holds the server (the
// agent reads that one first) or when the file uses the nested layout.
function keyPath(data, o, name) {
  const top = (data && data[o.key]) || {};
  // Same test as serverMap: a "servers" entry with a command or url is a
  // server of that name, not the nested map.
  const n = o.nested && top[o.nested];
  const inner = n && typeof n === "object" && !n.command && !n.url ? n : null;
  if (inner && (inner[name] || !top[name])) return [o.key, o.nested, name];
  return [o.key, name];
}

function jsonAgent(o) {
  // o.file(d), o.key ("mcpServers"), o.toEntry(def), o.fromEntry(name, raw, file)
  return {
    id: o.id,
    name: o.name,
    cli: o.cli || [],
    configDir: o.configDir,
    file: o.file,
    read(d) {
      // The file JMCP writes, plus any others the agent also reads.
      const files = [o.file(d)].concat(o.alsoReads ? o.alsoReads(d) : []).filter((f, i, all) => all.indexOf(f) === i);
      const servers = [];
      const errors = [];
      for (const file of files) {
        const j = readJson(file);
        if (j.error) errors.push(j.error);
        for (const [n, v] of Object.entries(serverMap(j.data, o))) {
          if (!v || typeof v !== "object" || servers.some((s) => s.name === n)) continue;
          servers.push(o.fromEntry ? o.fromEntry(n, v, file) : norm(n, v, file));
        }
      }
      return { servers, errors };
    },
    write(d, name, def) {
      const file = o.file(d);
      const j = readJson(file);
      if (j.error) throw new Error(j.error + " JMCP did not change it.");
      const where = keyPath(j.data, o, name);
      editJson(file, where, o.toEntry(def));
      // A flat copy beside the nested one would be shadowed and go stale.
      const top = (j.data && j.data[o.key]) || {};
      if (where.length === 3 && top[name] && typeof top[name] === "object") editJson(file, [o.key, name], undefined);
    },
    // Removes the server from every file the agent reads, not only the one
    // JMCP writes: it may have been added to the other one.
    remove(d, name) {
      const files = [o.file(d)].concat(o.alsoReads ? o.alsoReads(d) : []).filter((f, i, all) => all.indexOf(f) === i);
      let removed = false;
      for (const file of files) {
        const j = readJson(file);
        if (!j.exists || j.error) continue;
        // Both layouts can hold it: { mcp: { demo } } and { mcp: { servers: { demo } } }.
        const top = (j.data && j.data[o.key]) || {};
        const paths = [];
        if (top[name] && typeof top[name] === "object") paths.push([o.key, name]);
        if (o.nested && top[o.nested] && typeof top[o.nested] === "object" && top[o.nested][name]) paths.push([o.key, o.nested, name]);
        for (const p of paths) editJson(file, p, undefined);
        if (paths.length) removed = true;
      }
      return removed;
    },
  };
}

const stdioOrUrl = (def, stdio, remote) => (def.url ? remote(def) : stdio(def));

function tomlAgent(o) {
  return {
    id: o.id,
    name: o.name,
    cli: o.cli || [],
    configDir: o.configDir,
    file: o.file,
    read(d) {
      const file = o.file(d);
      const t = readToml(file);
      const map = (t.data && t.data.mcp_servers) || {};
      return { servers: Object.entries(map).map(([n, v]) => norm(n, v, file)), errors: t.error ? [t.error] : [], files: [{ file, exists: t.exists }] };
    },
    write(d, name, def) {
      const file = o.file(d);
      const t = readToml(file);
      if (t.error) throw new Error(t.error + " JMCP did not change it.");
      setTomlServer(file, name, o.toEntry(def));
    },
    remove(d, name) {
      const file = o.file(d);
      const t = readToml(file);
      if (!t.exists || !((t.data.mcp_servers || {})[name])) return false;
      deleteTomlServer(file, name);
      return true;
    },
  };
}

const AGENTS = [
  jsonAgent({
    id: "claude-code",
    name: "Claude Code",
    cli: ["claude"],
    configDir: (d) => path.join(d.home, ".claude"),
    file: (d) => path.join(d.home, ".claude.json"),
    key: "mcpServers",
    toEntry: (def) => stdioOrUrl(def, (x) => ({ type: "stdio", command: x.command, args: x.args || [], env: x.env || {} }), (x) => ({ type: "http", url: x.url })),
  }),
  tomlAgent({
    id: "codex",
    name: "Codex",
    cli: ["codex"],
    configDir: (d) => path.join(d.home, ".codex"),
    file: (d) => path.join(d.home, ".codex", "config.toml"),
    // Codex passes MCP servers only a few env vars unless env_vars names
    // more; JMCP_SUBAGENT must reach jmcp-subagents so a Codex subagent
    // cannot start its own. Its default tool timeout (60 s) is too short for
    // subagent work.
    toEntry: (def) =>
      def.url
        ? { url: def.url, enabled: true }
        : Object.assign({ command: def.command, args: def.args || [] }, def.passEnv ? { env_vars: def.passEnv } : {}, def.toolTimeoutSec ? { tool_timeout_sec: def.toolTimeoutSec } : {}, { enabled: true, env: def.env || {} }),
  }),
  jsonAgent({
    id: "factory-droid",
    name: "Factory Droid",
    cli: ["droid"],
    configDir: (d) => path.join(d.home, ".factory"),
    file: (d) => path.join(d.home, ".factory", "mcp.json"),
    key: "mcpServers",
    toEntry: (def) => stdioOrUrl(def, (x) => ({ type: "stdio", command: x.command, args: x.args || [], env: x.env || {}, disabled: false }), (x) => ({ type: "http", url: x.url, disabled: false })),
  }),
  jsonAgent({
    id: "opencode",
    name: "OpenCode",
    cli: ["opencode"],
    configDir: (d) => path.join(d.xdg, "opencode"),
    file: (d) => {
      const jc = path.join(d.xdg, "opencode", "opencode.jsonc");
      const j = path.join(d.xdg, "opencode", "opencode.json");
      return fs.existsSync(j) || !fs.existsSync(jc) ? j : jc;
    },
    alsoReads: (d) => [path.join(d.xdg, "opencode", "opencode.json"), path.join(d.xdg, "opencode", "opencode.jsonc")],
    key: "mcp",
    nested: "servers",
    fromEntry: (n, v, file) => norm(n, Object.assign({}, v, { type: v.type === "remote" ? "http" : "stdio" }), file),
    toEntry: (def) => stdioOrUrl(def, (x) => ({ type: "local", command: [x.command].concat(x.args || []), environment: x.env || {}, enabled: true }), (x) => ({ type: "remote", url: x.url, enabled: true })),
  }),
  jsonAgent({
    id: "devin",
    name: "Devin",
    cli: ["devin"],
    configDir: (d) => (d.win ? path.join(d.appData, "devin") : path.join(d.xdg, "devin")),
    file: (d) => (d.win ? path.join(d.appData, "devin", "mcp_config.json") : path.join(d.xdg, "devin", "mcp_config.json")),
    key: "mcpServers",
    toEntry: (def) => stdioOrUrl(def, (x) => ({ command: x.command, args: x.args || [], env: x.env || {}, transport: "stdio" }), (x) => ({ url: x.url, transport: "http" })),
  }),
  jsonAgent({
    id: "cursor",
    name: "Cursor",
    cli: ["cursor-agent", "agent"],
    configDir: (d) => path.join(d.home, ".cursor"),
    file: (d) => path.join(d.home, ".cursor", "mcp.json"),
    key: "mcpServers",
    toEntry: (def) => stdioOrUrl(def, (x) => ({ command: x.command, args: x.args || [], env: x.env || {} }), (x) => ({ url: x.url })),
  }),
  jsonAgent({
    id: "gemini",
    name: "Gemini CLI",
    cli: ["gemini"],
    configDir: (d) => path.join(d.home, ".gemini"),
    file: (d) => path.join(d.home, ".gemini", "settings.json"),
    key: "mcpServers",
    toEntry: (def) => stdioOrUrl(def, (x) => ({ command: x.command, args: x.args || [], env: x.env || {}, timeout: 1800000 }), (x) => ({ httpUrl: x.url })),
  }),
  jsonAgent({
    id: "qwen",
    name: "Qwen Code",
    cli: ["qwen"],
    configDir: (d) => path.join(d.home, ".qwen"),
    file: (d) => path.join(d.home, ".qwen", "settings.json"),
    key: "mcpServers",
    toEntry: (def) => stdioOrUrl(def, (x) => ({ command: x.command, args: x.args || [], env: x.env || {}, timeout: 1800000 }), (x) => ({ httpUrl: x.url })),
  }),
  tomlAgent({
    id: "grok",
    name: "Grok",
    cli: ["grok"],
    configDir: (d) => path.join(d.home, ".grok"),
    file: (d) => path.join(d.home, ".grok", "config.toml"),
    toEntry: (def) => (def.url ? { url: def.url, enabled: true } : { command: def.command, args: def.args || [], enabled: true, env: def.env || {} }),
  }),
];

function findCli(names) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").concat([""]) : [""];
  const pathDirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extra = [path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), "bin"), path.join(os.homedir(), ".grok", "bin"), path.join(process.env.LOCALAPPDATA || "", "devin", "cli", "bin")];
  for (const n of names) {
    for (const dir of pathDirs.concat(extra)) {
      for (const e of exts) {
        const f = path.join(dir, n + e.toLowerCase());
        try {
          if (fs.statSync(f).isFile()) return f;
        } catch {
          /* next */
        }
      }
    }
  }
  return "";
}

function agentById(id) {
  return AGENTS.find((a) => a.id === id) || null;
}

// Everything JMCP shows: each agent, whether it is on this computer, and its servers.
function scan(home) {
  const d = dirs(home);
  return AGENTS.map((a) => {
    let r;
    try {
      r = a.read(d);
    } catch (e) {
      r = { servers: [], errors: [String(e.message || e)], files: [] };
    }
    const cli = home ? "" : findCli(a.cli);
    const hasDir = fs.existsSync(a.configDir(d));
    return { id: a.id, name: a.name, present: Boolean(cli) || hasDir, cli, configFile: a.file(d), servers: r.servers, errors: r.errors };
  });
}

function install(agentId, name, def, home) {
  const a = agentById(agentId);
  if (!a) throw new Error("Unknown agent " + agentId + ".");
  a.write(dirs(home), name, def);
  return { agent: a.id, name, file: a.file(dirs(home)) };
}

function uninstall(agentId, name, home) {
  const a = agentById(agentId);
  if (!a) throw new Error("Unknown agent " + agentId + ".");
  return { agent: a.id, name, removed: a.remove(dirs(home), name), file: a.file(dirs(home)) };
}

module.exports = { AGENTS, agentById, scan, install, uninstall, dirs, _toml: { removeTomlServer, tomlServerBlock, tomlHeader } };
