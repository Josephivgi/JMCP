#!/usr/bin/env node
"use strict";

// Read the app's rules on each request so running agents see edits immediately.

const { active, instructions } = require("./lib/store.js");
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = require("./package.json").version;

const TOOL = {
  name: "rules",
  description: "Call this read-only tool at the start of every task. Some agents ignore server instructions, and the user's JMCP rules may have changed since this session began.",
  inputSchema: { type: "object", properties: {} },
};

function rulesText() {
  return instructions(active());
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
      const text = rulesText();
      return send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "jmcp-rules", title: "JMCP Rules", version: VERSION },
          instructions: "These are the user's rules, set in JMCP, and must be followed." + (text ? "\n\n" + text : ""),
        },
      });
    }
    if (method === "ping") return isRequest && send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
    if (method === "tools/call") {
      if (!params || params.name !== "rules")
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Unknown tool " + (params && params.name) }], isError: true } });
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: rulesText() }], isError: false } });
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

module.exports = { handle };
