#!/usr/bin/env node
"use strict";

// The JMCP skills library for every agent. Reads ~/.jmcp/skills.db on each
// call, so skills added or turned off in the app reach running agents.

const store = require("./lib/store.js");
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = require("./package.json").version;

const TOOLS = [
  {
    name: "skills_list",
    description: "List the user's skills with what each is for. Check it at the start of a task, and load any skill whose description matches the work with skill_read.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "skill_read",
    description: "Load a skill's full instructions by name. Follow them for the task they describe.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Skill name from skills_list" } }, required: ["name"] },
    annotations: { readOnlyHint: true },
  },
];

function call(name, a) {
  a = a || {};
  if (name === "skills_list") {
    const all = store.active();
    return all.length ? store.index(all) : "No skills are turned on in JMCP.";
  }
  if (name === "skill_read") {
    const s = store.get(undefined, a.name);
    if (!s || !s.enabled) throw new Error("No skill named " + a.name + " is turned on. Use skills_list.");
    const files = store.supportFiles(s);
    return "# Skill: " + s.name + "\n" + s.description + "\n\n" + s.body +
      (files.length ? "\n\n---\nThis skill's folder has these files. Paths in the instructions are relative to " + require("node:path").dirname(s.origin) + ":\n" + files.map((f) => "- " + f).join("\n") : "");
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
      const all = store.active();
      return send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "jmcp-skills", title: "JMCP Skills", version: VERSION },
          instructions:
            "The user's skills, managed in JMCP. When a task matches a skill's description, load it with skill_read before starting and follow it." +
            (all.length ? "\n\nSkills:\n" + store.index(all) : "\n\nNo skills are turned on yet."),
        },
      });
    }
    if (method === "ping") return isRequest && send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      try {
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: call(params && params.name, params && params.arguments) }], isError: false } });
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

module.exports = { handle };
