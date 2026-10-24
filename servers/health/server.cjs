#!/usr/bin/env node
"use strict";

// Reads health data from this computer or an SSH host and explains what is
// wrong: problems found, why text is slow to show in the browser, and why the
// computer feels glitchy. Read-only: it never changes anything on the target.

const { collect, sshHosts, checkTarget } = require("./lib/collect.js");
const { analyze, summary, TEXT_REASONS, GLITCH_REASONS } = require("./lib/analyze.js");
const { checkPage } = require("./lib/page.js");
const notes = require("./lib/notes.js");
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = require("./package.json").version;

const TARGET = {
  type: "string",
  description: "\"local\" for this computer (default), an alias from ~/.ssh/config, or user@host. SSH uses key auth only (BatchMode).",
};

const TOOLS = [
  {
    name: "targets",
    description: "List the computers this server can check: this computer and the named hosts in ~/.ssh/config.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "problems",
    description: "Collect CPU, memory, disk, event log/journal, GPU, power, network and browser data from the target and list every problem found, worst first, with evidence, why it matters and a fix. Read-only. Takes 5-30 seconds.",
    inputSchema: { type: "object", properties: { target: TARGET }, additionalProperties: false },
  },
  {
    name: "slow_text",
    description: "Explain why text might take a second to show in the browser. Checks the target's network, CPU, RAM, GPU acceleration, extensions and fonts. With url, also loads that page from the target and times DNS, connect, TLS, server wait and download, and reads the HTML for web fonts without font-display: swap, render-blocking CSS/JS and client-side rendering.",
    inputSchema: {
      type: "object",
      properties: { target: TARGET, url: { type: "string", description: "Optional page to test, e.g. https://example.com" } },
      additionalProperties: false,
    },
  },
  {
    name: "glitchy",
    description: "Explain why the target computer might be glitchy (stutter, freezes, flicker, crashes): RAM and swap, CPU hogs, driver latency, GPU driver resets, WHEA hardware errors, unexpected shutdowns, blue screens, heat, disk health, power plan.",
    inputSchema: { type: "object", properties: { target: TARGET }, additionalProperties: false },
  },
  {
    name: "show_user",
    description: "Put a card on the Health page of the JMCP app for the user to read later: a finding, a warning, a finished result or something they should act on. Use it for things worth seeing after this chat ends, not for normal replies. Keep it short.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "One line, under 100 characters." },
        body: { type: "string", description: "Optional details in plain text, a few sentences. What happened, why it matters, what to do." },
        level: { type: "string", enum: notes.LEVELS, description: "info (default), good, warning or problem." },
        about: { type: "string", description: "Optional: what it is about, e.g. a host alias, a project or \"this computer\"." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
];

let client = "";

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }], isError: false });
const fail = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

function verdict(problems, okText) {
  const bad = problems.filter((p) => p.severity === "high" || p.severity === "medium");
  if (!bad.length) return okText;
  return "Found " + bad.length + " likely cause(s). Worst: " + bad.slice(0, 3).map((p) => p.title).join("; ") + ".";
}

async function callTool(name, args) {
  args = args || {};
  if (name === "show_user") {
    const n = notes.add(undefined, Object.assign({}, args, { author: client || "an agent" }));
    return text("Shown to the user on the JMCP Health page: " + JSON.stringify(n.title) + ".");
  }
  if (name === "targets") {
    return text({ local: { name: "local", os: process.platform }, ssh: sshHosts() });
  }
  if (name === "problems") {
    const f = await collect(args.target);
    const problems = analyze(f);
    return text({ summary: summary(f), verdict: verdict(problems, "No problems found."), problems });
  }
  if (name === "glitchy") {
    const f = await collect(args.target);
    const problems = analyze(f).filter((p) => p.affects.includes("glitch"));
    return text({
      summary: summary(f),
      verdict: verdict(problems, "Nothing measured points at glitches right now. If it still happens, run this again while it is glitching; event-log checks cover the last 7 days."),
      causes: problems,
      commonCauses: GLITCH_REASONS,
    });
  }
  if (name === "slow_text") {
    const tasks = [collect(args.target)];
    if (args.url) tasks.push(checkPage(checkTarget(args.target), String(args.url), 30000).catch((e) => ({ error: String(e.message || e) })));
    const [f, page] = await Promise.all(tasks);
    const problems = analyze(f).filter((p) => p.affects.includes("text"));
    const all = page && page.problems ? page.problems.concat(problems) : problems;
    all.sort((a, b) => ["high", "medium", "low", "info"].indexOf(a.severity) - ["high", "medium", "low", "info"].indexOf(b.severity));
    const out = { summary: summary(f), verdict: verdict(all, "This computer and its connection look fine." + (args.url ? "" : " Pass url to test a specific page; most slow text comes from the page itself (web fonts, blocking CSS/JS, slow server).")), causes: all };
    if (page) {
      if (page.error) out.pageError = page.error;
      else Object.assign(out, { page: page.page, html: page.html });
    }
    out.commonCauses = TEXT_REASONS;
    return text(out);
  }
  return fail("Unknown tool " + name);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg || {};
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === "initialize") {
      const asked = params && params.protocolVersion;
      client = String((params && params.clientInfo && params.clientInfo.name) || "").slice(0, 80);
      return send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "jmcp-health", title: "JMCP Health", version: VERSION },
          instructions: "Diagnoses this computer or SSH hosts, read-only. Use targets to see hosts, problems for everything found, slow_text for slow-loading text in the browser (pass url to test a page), glitchy for stutter and crashes. Explain the results to the user in plain words, worst first. Use show_user to leave the user a card on the JMCP Health page when you find something they should see later.",
        },
      });
    }
    if (method === "ping") return isRequest && send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      let result;
      try {
        result = await callTool(params && params.name, params && params.arguments);
      } catch (e) {
        result = fail(String(e.message || e));
      }
      return send({ jsonrpc: "2.0", id, result });
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

module.exports = { handle, callTool, TOOLS };
