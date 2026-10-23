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
// --home <dir> works on a scratch home folder instead of yours.

const agents = require("../core/agents.cjs");
const catalog = require("../core/catalog.cjs");
const { probe } = require("../core/mcp-client.cjs");

const argv = process.argv.slice(2);
let home = "";
const hi = argv.indexOf("--home");
if (hi >= 0) {
  home = argv[hi + 1];
  argv.splice(hi, 2);
}
const json = argv.includes("--json");
const force = argv.includes("--force");
const args = argv.filter((a) => a !== "--json" && a !== "--force");
const [cmd, ...rest] = args;

function out(value, text) {
  console.log(json ? JSON.stringify(value, null, 2) : text());
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
  console.log("Usage: jmcp list | catalog | install <server> [agents..] | uninstall <server> [agents..] | update [server] | probe <agent> <server>  [--home dir] [--json]");
}

main().catch((e) => {
  console.error(String(e.message || e) + (e.already ? " Add --force to do it anyway." : ""));
  process.exit(1);
});
