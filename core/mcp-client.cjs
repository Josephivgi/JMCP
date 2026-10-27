"use strict";

// A small MCP client for stdio servers. JMCP uses it to probe a configured
// server (start it hidden, initialize, list its tools, stop it) and in tests
// to drive jmcp-subagents the way a coding agent would.

const { spawn } = require("node:child_process");

function connect(command, args, opts) {
  const o = opts || {};
  const child = spawn(command, args || [], {
    cwd: o.cwd,
    env: Object.assign({}, process.env, o.env || {}),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: Boolean(o.shell),
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
    stderr = (stderr + c).slice(-4000);
  });
  const fail = (e) => {
    closed = e;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code) => fail(new Error("Server exited with code " + code + (stderr.trim() ? ": " + stderr.trim().split("\n").pop() : ""))));

  function request(method, params, timeoutMs) {
    if (closed) return Promise.reject(closed);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method + " timed out"));
      }, timeoutMs || 30000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
    });
  }
  function notify(method, params) {
    if (!closed) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }) + "\n");
  }
  async function initialize(clientName, timeoutMs) {
    const res = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName || "jmcp", version: "0.1.0" } }, timeoutMs);
    notify("notifications/initialized");
    return res;
  }
  async function callTool(name, args, timeoutMs) {
    const res = await request("tools/call", { name, arguments: args || {} }, timeoutMs || 600000);
    const text = ((res && res.content) || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // jmcp-subagents sends a reply as plain text after its JSON.
      const at = text.indexOf("\n\nReply:\n");
      if (at > 0) {
        try {
          json = Object.assign(JSON.parse(text.slice(0, at)), { reply: text.slice(at + 9) });
        } catch {
          /* plain text */
        }
      }
    }
    return { isError: Boolean(res && res.isError), text, json };
  }
  function close() {
    try {
      child.stdin.end();
    } catch {
      /* gone */
    }
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* gone */
        }
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      if (closed) {
        clearTimeout(t);
        resolve();
      }
    });
  }
  return { child, request, notify, initialize, callTool, close, stderr: () => stderr };
}

// Start a stdio server, list its tools, stop it.
async function probe(def, timeoutMs) {
  const c = connect(def.command, def.args, { env: def.env, cwd: def.cwd, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(def.command || "") });
  try {
    const init = await c.initialize("jmcp-probe", timeoutMs || 20000);
    const res = await c.request("tools/list", {}, timeoutMs || 20000);
    return { ok: true, server: init.serverInfo || {}, tools: ((res && res.tools) || []).map((t) => ({ name: t.name, description: String(t.description || "").slice(0, 300) })) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    await c.close();
  }
}

module.exports = { connect, probe };
