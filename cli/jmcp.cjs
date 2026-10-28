#!/usr/bin/env node
"use strict";

// jmcp: the JMCP app's features from a terminal.
//   jmcp list                         every agent and its MCP servers
//   jmcp catalog                      JMCP servers and where they are installed
//   jmcp install <server> [agents..]  install into the given agents (default: all found);
//                                     --force to write it again where it already is
//   jmcp uninstall <server> [agents..]
//   jmcp update [server]              update installed JMCP servers to this version
//   jmcp probe <agent> <server>       start a configured server and list its tools
//   jmcp rules list                   show rules set in the JMCP app (read-only)
//   jmcp memory list                  show memories agents share (jmcp-memory)
//   jmcp skills list                  show the skills library (jmcp-skills)
//   jmcp instructions list [folder]   instruction files (AGENTS.md, CLAUDE.md, ...)
//   jmcp connections                  apps connected to JMCP (JAgents Terminal, ...)
//   jmcp connect <app> | disconnect <app>
// --home <dir> works on a scratch home folder instead of yours.

const agents = require("../core/agents.cjs");
const catalog = require("../core/catalog.cjs");
const rules = require("../core/rules.cjs");
const memory = require("../core/memory.cjs");
const skills = require("../core/skills.cjs");
const instructions = require("../core/instructions.cjs");
const { probe } = require("../core/mcp-client.cjs");
const connections = require("../core/connections.cjs");

const argv = process.argv.slice(2);
let home = "";
const hi = argv.indexOf("--home");
if (hi >= 0) {
  home = argv[hi + 1];
  // Without a folder the command would run on the real home.
  if (!home || home.startsWith("--")) {
    console.error("--home needs a folder, for example --home C:\\temp\\jmcp-test.");
    process.exit(2);
  }
  argv.splice(hi, 2);
}
const json = argv.includes("--json");
const force = argv.includes("--force");
const args = argv.filter((a) => a !== "--json" && a !== "--force");
const [cmd, ...rest] = args;

// Prints the result. Any failed item (ok: false, at the top or in results)
// makes the command exit with 1, so scripts can tell.
function out(value, text) {
  console.log(json ? JSON.stringify(value, null, 2) : text());
  const items = Array.isArray(value) ? value : [value];
  const failed = items.some((x) => x && (x.ok === false || (Array.isArray(x.results) && x.results.some((r) => r && r.ok === false))));
  if (failed) process.exitCode = 1;
}

async function main() {
  if (cmd === "list") {
    const list = agents.scan(home || undefined);
    return out(list, () =>
      list
        .map((a) => (a.present ? "● " : "○ ") + a.name + "  " + a.configFile + (a.errors.length ? "  ! " + a.errors.join("; ") : "") + "\n" + (a.servers.length ? a.servers.map((s) => "    " + (s.enabled ? "" : "(off) ") + s.name + "  " + (s.url || [s.command].concat(s.args).join(" "))).join("\n") : "    (no MCP servers)"))
        .join("\n"),
    );
  }
  if (cmd === "catalog") {
    const st = catalog.catalogState(home || undefined);
    return out(st, () => st.map((c) => c.name + (c.official ? " (official)" : "") + "\n  " + c.description + "\n  installed in: " + (c.installedIn.join(", ") || "none")).join("\n"));
  }
  if (cmd === "rules" && rest[0] === "list" && rest.length === 1) {
    const list = rules.list(home || undefined);
    return out(list, () => list.map((r) =>
      (r.enabled ? "" : "(off) ") + r.kind.toUpperCase() + "  " + r.text,
    ).join("\n") || "  (no rules)");
  }
  if (cmd === "instructions" && rest[0] === "list") {
    const r = instructions.list(home || undefined, rest[1]);
    return out(r, () =>
      r.agents.map((f) => (f.exists ? "● " : "○ ") + f.agent + "  " + f.path).join("\n") +
      r.folders.map((d) => "\n" + d.path + (d.files.length ? d.files.map((f) => "\n    " + f.name).join("") : "\n    (no instruction files)")).join(""),
    );
  }
  if (cmd === "memory" && rest[0] === "list" && rest.length === 1) {
    const list = memory.list(home || undefined);
    return out(list, () => list.map((m) => m.name + "  " + m.title + "  (" + m.author + ")").join("\n") || "  (no memories)");
  }
  if (cmd === "skills" && rest[0] === "list" && rest.length === 1) {
    const list = skills.list(home || undefined);
    return out(list, () => list.map((s) => (s.enabled ? "" : "(off) ") + s.name + "  " + s.description.slice(0, 100)).join("\n") || "  (no skills)");
  }
  if (cmd === "connections" && (!rest[0] || (rest[0] === "list" && rest.length === 1))) {
    const list = connections.list(home || undefined);
    return out(list, () => list.map((a) =>
      a.name + "  " + (a.state === "connected" ? (a.pluginMissing ? "connected, but the JMCP plugin was removed in the app" : "connected") : a.state === "disconnected" ? "disconnected" : "not connected") + (a.present ? "" : " (not installed)") +
      (a.lastSeen ? "\n    last seen " + new Date(a.lastSeen).toLocaleString() : "") + "\n    " + a.pluginDir,
    ).join("\n"));
  }
  if (cmd === "connect" || cmd === "disconnect") {
    if (!rest[0]) throw new Error("Usage: jmcp " + cmd + " <app>. Apps: " + connections.APPS.map((a) => a.id).join(", "));
    const r = cmd === "connect" ? connections.connect(home || undefined, rest[0]) : connections.disconnect(home || undefined, rest[0]);
    return out(r, () => "  ✓  " + r.name + " " + r.state + "  " + r.pluginDir);
  }
  if (cmd === "install" || cmd === "uninstall") {
    if (!rest[0]) throw new Error("Usage: jmcp " + cmd + " <server> [agents...]");
    const r = cmd === "install" ? await catalog.installServer(rest[0], rest.slice(1), home || undefined, { force }) : catalog.uninstallServer(rest[0], rest.slice(1), home || undefined);
    return out(r, () => r.results.map((x) => (x.ok ? (x.removed === false ? "  -  " : "  ✓  ") : "  ✗  ") + x.agent + "  " + (x.ok ? x.file : x.error)).join("\n"));
  }
  if (cmd === "update") {
    const r = rest[0] ? [await catalog.updateServer(rest[0], home || undefined)] : await catalog.updateAll(home || undefined);
    return out(r, () => (r.length ? r.map((x) => (x.ok === false ? "  ✗  " + x.server + "  " + x.error : "  ✓  " + x.server + "  " + x.from + " → " + x.to + "  (" + x.results.length + " agents)")).join("\n") : "  Everything is up to date."));
  }
  if (cmd === "probe") {
    const a = agents.scan(home || undefined).find((x) => x.id === rest[0]);
    const s = a && a.servers.find((x) => x.name === rest[1]);
    if (!s) throw new Error("No server " + rest[1] + " in " + rest[0] + ".");
    if (s.transport !== "stdio") throw new Error("Only stdio servers can be probed.");
    const r = await probe(s);
    return out(r, () => (r.ok ? r.tools.map((t) => "  " + t.name).join("\n") || "  (no tools)" : "  ✗ " + r.error));
  }
  console.log("Usage: jmcp list | catalog | rules list | memory list | skills list | instructions list [folder] | connections | connect <app> | disconnect <app> | install <server> [agents..] | uninstall <server> [agents..] | update [server] | probe <agent> <server>  [--home dir] [--json]");
}

main().catch((e) => {
  console.error(String(e.message || e) + (e.already ? " Add --force to do it anyway." : ""));
  process.exit(1);
});
