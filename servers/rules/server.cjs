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
  inputSchema: { type: "object", properties: {} },
};

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
    return { content: [{ type: "text", text: rulesText() }], isError: false };
  },
  "resources/list": () => ({ resources: [] }),
  "prompts/list": () => ({ prompts: [] }),
};

if (require.main === module) serve(methods);

module.exports = { methods };
