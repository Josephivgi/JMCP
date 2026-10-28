"use strict";

// JMCP for the JAgents Terminal plugin. JMCP copies this folder into
// JAgents Terminal's plugins folder when you connect it. It reads JMCP's own
// data (~/.jmcp) and runs the installed JMCP servers, so it needs nothing
// from the JMCP app itself.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const APP_ID = "jagents-terminal";

// connection.json is written by JMCP next to this file.
function config() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "connection.json"), "utf8"));
  } catch {
    return {};
  }
}

function jmcpHome() {
  const c = config();
  return c.jmcpHome ? path.resolve(c.jmcpHome) : path.join(os.homedir(), ".jmcp");
}

function openDb(file, readOnly) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  db.exec("PRAGMA busy_timeout=3000");
  return db;
}

// JMCP shows when this app was last seen. Only JMCP adds or removes the row.
function heartbeat(now) {
  const file = path.join(jmcpHome(), "connections.db");
  if (!fs.existsSync(file)) return false;
  const db = openDb(file);
  try {
    return db.prepare("UPDATE connections SET last_seen = ?, client_version = ? WHERE app = ?").run(now || Date.now(), version(), APP_ID).changes > 0;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function version() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(__dirname, "plugin.json"), "utf8")).version || "");
  } catch {
    return "";
  }
}

// JMCP servers installed in ~/.jmcp/servers, with their versions.
function servers() {
  const dir = path.join(jmcpHome(), "servers");
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[a-z]+$/.test(e.name)).map((e) => e.name).sort();
  } catch {
    return [];
  }
  return names
    .filter((id) => fs.existsSync(path.join(dir, id, "server.cjs")))
    .map((id) => {
      let v = "";
      try {
        v = String(JSON.parse(fs.readFileSync(path.join(dir, id, "package.json"), "utf8")).version || "");
      } catch {
        /* no version */
      }
      return { id, name: "jmcp-" + id, version: v };
    });
}

// Subagents started through jmcp-subagents by any agent, newest first.
function subagents(limit) {
  const file = path.join(jmcpHome(), "subagents.db");
  if (!fs.existsSync(file)) return [];
  const db = openDb(file, true);
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subagents'").get()) return [];
    const n = Math.max(1, Math.min(200, Number(limit) || 20));
    return db
      .prepare("SELECT handle, parent, provider_name AS provider, model, status, task, cwd, error, updated_at AS updatedAt FROM subagents ORDER BY updated_at DESC LIMIT ?")
      .all(n)
      .map((r) => Object.assign({}, r, { task: String(r.task || "").slice(0, 300) }));
  } finally {
    db.close();
  }
}

const RUNNING = new Set(["starting", "running", "busy"]);

function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    } catch {
      /* gone */
    }
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill();
      } catch {
        /* gone */
      }
    }
  }
}

// One stdio MCP client per JMCP server, kept running so a subagent started
// with spawn is still there for wait, send and read.
function createClients() {
  const clients = new Map();

  function start(id) {
    const entry = path.join(jmcpHome(), "servers", id, "server.cjs");
    if (!/^[a-z]+$/.test(id) || !fs.existsSync(entry)) throw new Error("jmcp-" + id + " is not installed. Install it on the JMCP servers page.");
    const child = spawn(process.execPath, [entry], {
      cwd: path.dirname(entry),
      env: Object.assign({}, process.env, { JMCP_HOME: jmcpHome(), JMCP_CLIENT: APP_ID }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const pending = new Map();
    let nextId = 1;
    let buffer = "";
    let stderr = "";
    let closed = null;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const p = msg && msg.id !== undefined ? pending.get(msg.id) : null;
        if (!p) continue;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || "MCP error"));
        else p.resolve(msg.result);
      }
    });
    child.stderr.on("data", (c) => {
      stderr = (stderr + c).slice(-2000);
    });
    const fail = (e) => {
      closed = e;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      pending.clear();
      if (clients.get(id) && clients.get(id).child === child) clients.delete(id);
    };
    child.on("error", fail);
    child.on("exit", (code) => fail(new Error("jmcp-" + id + " stopped (code " + code + ")" + (stderr.trim() ? ": " + stderr.trim().split("\n").pop() : ""))));
    function request(method, params, timeoutMs) {
      if (closed) return Promise.reject(closed);
      const rid = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(rid);
          reject(new Error(method + " timed out"));
        }, timeoutMs || 30000);
        pending.set(rid, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params: params || {} }) + "\n");
      });
    }
    const ready = request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jagents-terminal", version: version() } }, 20000).then(() => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    });
    ready.catch(() => killTree(child));
    const c = { child, request, ready };
    clients.set(id, c);
    return c;
  }

  async function client(id) {
    const c = clients.get(id) || start(id);
    await c.ready;
    return c;
  }

  return {
    async tools(id) {
      const c = await client(id);
      const r = await c.request("tools/list", {}, 20000);
      return ((r && r.tools) || []).map((t) => ({ name: t.name, description: String(t.description || "").slice(0, 300) }));
    },
    // The tool's text, and its JSON when the text is JSON.
    async call(id, tool, args, timeoutMs) {
      const c = await client(id);
      const r = await c.request("tools/call", { name: tool, arguments: args || {} }, timeoutMs || 1800000);
      const text = ((r && r.content) || []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* plain text */
      }
      return { isError: Boolean(r && r.isError), text, json };
    },
    running: () => [...clients.keys()],
    close() {
      for (const c of clients.values()) {
        try {
          c.child.stdin.end();
        } catch {
          /* gone */
        }
        killTree(c.child);
      }
      clients.clear();
    },
  };
}

module.exports = { APP_ID, jmcpHome, heartbeat, version, servers, subagents, RUNNING, createClients, killTree };
