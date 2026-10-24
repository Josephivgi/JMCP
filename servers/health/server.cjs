#!/usr/bin/env node
"use strict";

// Reads health data from this computer or an SSH host and explains what is
// wrong: problems found, why text is slow to show in the browser, and why the
// computer feels glitchy. Read-only, except the updates tool with install:
// true, which installs package updates on an SSH host when asked.

const { collect, sshHosts, checkTarget } = require("./lib/collect.js");
const { analyze, summary, TEXT_REASONS, GLITCH_REASONS } = require("./lib/analyze.js");
const { checkPage } = require("./lib/page.js");
const notes = require("./lib/notes.js");
const quick = require("./lib/quick.js");
const { rpcError, serve, checkArgs } = require("./lib/rpc.js");
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
    name: "updates",
    description: "Pending package updates on an SSH host from ~/.ssh/config (apt or dnf). Without install it only checks and shows what would be installed. With install: true it installs them the same way as the JMCP Health page: apt-get upgrade --with-new-pkgs (dist-upgrade on Proxmox) or dnf upgrade, as root or with passwordless sudo. It keeps config files, removes nothing and never reboots. Only install when the user asked for updates on that host.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Host alias from ~/.ssh/config (see targets)." },
        install: { type: "boolean", description: "true installs the updates. Leave out to only check." },
      },
      required: ["target"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, openWorldHint: true },
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

const INSTRUCTIONS = "Diagnoses this computer or SSH hosts. Use targets to see hosts, problems for everything found, slow_text for slow-loading text in the browser (pass url to test a page), glitchy for stutter and crashes, and updates to check pending package updates on a host (install: true installs them, only when the user asks). Explain the results to the user in plain words, worst first. Use show_user to leave the user a card on the JMCP Health page when you find something they should see later.";

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
  if (name === "updates") {
    const target = String(args.target || "");
    if (!sshHosts().some((h) => h.name === target)) return fail("Unknown host " + JSON.stringify(target) + ". Use a host alias from targets.");
    if (args.install === true) {
      const r = await quick.applyUpdates(target);
      if (!r.ok) return fail("Updates failed on " + target + ": " + r.error + (r.log ? "\n\nLast output:\n" + r.log : ""));
      const after = await quick.checkHost(target);
      return text({
        host: target,
        installed: r.installed,
        seconds: Math.round(r.ms / 1000),
        rebootNeeded: r.rebootNeeded,
        stillWaiting: after.ok && after.updates ? after.updates.packages : null,
        note: r.rebootNeeded ? "Reboot the host to finish. JMCP never reboots it." : undefined,
      });
    }
    const c = await quick.checkHost(target);
    if (!c.ok) return fail("Could not check " + target + ": " + c.error);
    if (!c.updates) return text({ host: target, note: "No apt-get or dnf on this host." });
    const sim = c.updates.count ? await quick.applyUpdates(target, undefined, { simulate: true }) : null;
    return text({
      host: target,
      waiting: c.updates.count,
      security: c.updates.security,
      packages: c.updates.packages,
      wouldInstall: sim && sim.ok ? sim.planned : undefined,
      previewError: sim && !sim.ok ? sim.error : undefined,
      canInstall: c.updates.canApply,
      rebootNeeded: c.rebootNeeded,
      listsUpdated: c.updates.listedAt ? new Date(c.updates.listedAt).toISOString() : null,
    });
  }
  return fail("Unknown tool " + name);
}

const methods = {
  initialize(params) {
    const asked = params.protocolVersion;
    client = String((params.clientInfo && params.clientInfo.name) || "").slice(0, 80);
    return {
      protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "jmcp-health", title: "JMCP Health", version: VERSION },
      instructions: INSTRUCTIONS,
    };
  },
  ping: () => ({}),
  "tools/list": () => ({ tools: TOOLS }),
  async "tools/call"(params) {
    const tool = TOOLS.find((t) => t.name === params.name);
    if (!tool) throw rpcError(-32602, "Unknown tool " + params.name);
    const wrong = checkArgs(tool.inputSchema, params.arguments);
    if (wrong) return fail("Invalid arguments: " + wrong);
    try {
      return await callTool(params.name, params.arguments);
    } catch (e) {
      return fail(String(e.message || e));
    }
  },
  "resources/list": () => ({ resources: [] }),
  "prompts/list": () => ({ prompts: [] }),
};

if (require.main === module) serve(methods);

module.exports = { methods, callTool, TOOLS };
