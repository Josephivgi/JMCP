#!/usr/bin/env node
"use strict";

// Lets agents list, read, write and delete instruction files (AGENTS.md,
// CLAUDE.md, GEMINI.md, QWEN.md). Deletes and overwrites keep a copy the
// JMCP app can restore.

const store = require("./lib/store.js");
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = require("./package.json").version;
const NAMES = store.NAMES.join(", ");

const pathProp = { type: "string", description: "Absolute path to the file. The name must be one of " + NAMES + "." };

const TOOLS = [
  {
    name: "list",
    description: "List instruction files: each agent's global file (made or not) and every project folder saved in JMCP. Pass folder to also list the files in that folder, such as your working folder.",
    inputSchema: { type: "object", properties: { folder: { type: "string", description: "Absolute folder to also look in." } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read",
    description: "Read an instruction file. Returns its text and a hash to pass to write.",
    inputSchema: { type: "object", properties: { path: pathProp }, required: ["path"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write",
    description: "Create or replace an instruction file with the full new content. Read it first and pass its hash so changes made since are not lost. The old version is kept and can be restored in the JMCP app.",
    inputSchema: {
      type: "object",
      properties: { path: pathProp, content: { type: "string", description: "The whole new file." }, hash: { type: "string", description: "Hash from read. Use an empty string for a new file." } },
      required: ["path", "content"],
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: "delete",
    description: "Delete an instruction file. Only do this when the user asked. The file is moved to the JMCP trash and can be restored in the JMCP app.",
    inputSchema: { type: "object", properties: { path: pathProp }, required: ["path"] },
    annotations: { destructiveHint: true },
  },
];

function size(n) {
  return n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB";
}

function listText(r) {
  const lines = ["Agent instruction files:"];
  for (const f of r.agents) lines.push("- " + f.agent + ": " + f.path + (f.exists ? " (" + size(f.size) + ")" : " (not made yet)"));
  if (r.folders.length) {
    lines.push("", "Project folders:");
    for (const d of r.folders) {
      lines.push("- " + d.path + (d.saved ? "" : " (not saved in JMCP)") + (d.exists ? "" : " (folder missing)"));
      for (const f of d.files) lines.push("  - " + f.path + " (" + size(f.size) + ")");
      if (d.exists && !d.files.length) lines.push("  - no instruction files");
    }
  }
  return lines.join("\n");
}

function call(name, a) {
  a = a || {};
  if (name === "list") return listText(store.list(undefined, a.folder || undefined));
  if (name === "read") {
    const r = store.read(a.path);
    return "Path: " + r.path + "\nHash: " + r.hash + "\n\n" + r.text;
  }
  if (name === "write") {
    const r = store.write(undefined, a.path, a.content, { by: "agent", expectedHash: typeof a.hash === "string" ? a.hash : undefined });
    if (!r.changed) return "No change: " + r.path + " already has that content.";
    return (r.created ? "Created " : "Saved ") + r.path + ". New hash: " + r.hash + (r.created ? "" : ". The old version can be restored in the JMCP app.");
  }
  if (name === "delete") {
    const r = store.remove(undefined, a.path, { by: "agent" });
    return "Deleted " + r.path + ". It is in the JMCP trash and can be restored from the JMCP app.";
  }
  throw new Error("Unknown tool " + name);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(msg) {
  const { id, method, params } = msg || {};
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === "initialize") {
      const asked = params && params.protocolVersion;
      return send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "jmcp-instructions", title: "JMCP Instructions", version: VERSION },
          instructions: "Use these tools when the user asks to see, change, create or remove agent instruction files (" + NAMES + "), for one agent or a project. Read a file before writing it and pass its hash. Delete only when the user asks; deleted and replaced files can be restored in the JMCP app.",
        },
      });
    }
    if (method === "ping") return isRequest && send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      const name = params && params.name;
      try {
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: call(name, params.arguments) }], isError: false } });
      } catch (e) {
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(e.message || e) }], isError: true } });
      }
    }
    if (method === "resources/list") return send({ jsonrpc: "2.0", id, result: { resources: [] } });
    if (method === "prompts/list") return send({ jsonrpc: "2.0", id, result: { prompts: [] } });
    if (!isRequest) return;
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
  } catch (e) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message || e) } });
  }
}

if (require.main === module) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
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
      if (Array.isArray(msg)) msg.forEach(handle);
      else handle(msg);
    }
  });
}

module.exports = { handle, TOOLS };
