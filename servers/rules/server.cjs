#!/usr/bin/env node
"use strict";

// Read the app's rules on each request so running agents see edits immediately.

const { active, instructions } = require("./lib/store.js");
const { rpcError, serve } = require("./lib/rpc.js");
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = require("./package.json").version;

const TOOL = {
  name: "rules",
  description: "Call this read-only tool at the start of every task. Some agents ignore server instructions, and the user's JMCP rules may have changed since this session began.",
  inputSchema: { type: "object", properties: { full: { type: "boolean", description: "Return the rules even if they have not changed since your last call" } } },
};

// Agents call this at the start of every task. Long rules that have not
// changed since the last call in this session come back as one line, not
// the whole text again; full: true always returns them.
const SHORT = 400;
let lastSent = null;

function rulesText() {
  return instructions(active());
}

const methods = {
  initialize(params) {
    const asked = params.protocolVersion;
    const text = rulesText();
    return {
      protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "jmcp-rules", title: "JMCP Rules", version: VERSION },
      instructions: "These are the user's rules, set in JMCP, and must be followed." + (text ? "\n\n" + text : ""),
    };
  },
  ping: () => ({}),
  "tools/list": () => ({ tools: [TOOL] }),
  "tools/call"(params) {
    if (params.name !== "rules") throw rpcError(-32602, "Unknown tool " + params.name);
    const text = rulesText();
    const full = Boolean(params.arguments && params.arguments.full === true);
    if (!full && text.length > SHORT && text === lastSent) {
      return { content: [{ type: "text", text: "The rules have not changed since you last called this tool in this session. Keep following them. If they are no longer in your context, call again with full: true." }], isError: false };
    }
    lastSent = text;
    return { content: [{ type: "text", text }], isError: false };
  },
  "resources/list": () => ({ resources: [] }),
  "prompts/list": () => ({ prompts: [] }),
};

if (require.main === module) serve(methods);

module.exports = { methods };
