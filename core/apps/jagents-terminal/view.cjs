"use strict";

// The JMCP view: runs in its own JAgents Terminal tab and shows JMCP
// servers and subagents, refreshed every few seconds. q or Ctrl+C closes it.

const lib = require("./lib.cjs");

const EVERY_MS = 3000;
const ago = (t) => {
  if (!t) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? s + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago";
};
const cut = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function frame() {
  const width = Math.max(40, Math.min(process.stdout.columns || 100, 160));
  const rows = [];
  rows.push("JMCP  connected to JAgents Terminal", "");
  const servers = lib.servers();
  rows.push("Servers (" + servers.length + ")");
  if (!servers.length) rows.push("  None installed. Install them on the JMCP servers page.");
  for (const s of servers) rows.push("  " + s.name.padEnd(20) + s.version);
  rows.push("");
  let subs = [];
  let err = "";
  try {
    subs = lib.subagents(Math.max(5, (process.stdout.rows || 30) - servers.length - 10));
  } catch (e) {
    err = String(e.message || e);
  }
  const live = subs.filter((s) => lib.RUNNING.has(s.status)).length;
  rows.push("Subagents (" + live + " working, " + subs.length + " recent)");
  if (err) rows.push("  Could not read subagents: " + err);
  else if (!subs.length) rows.push("  None yet. Agents start them with jmcp-subagents.");
  for (const s of subs) {
    const head = "  " + cut(s.handle, 14).padEnd(15) + cut(s.status, 9).padEnd(10) + cut(s.provider, 14).padEnd(15) + ago(s.updatedAt).padEnd(9);
    rows.push(head + cut(s.task, Math.max(10, width - head.length - 1)));
  }
  rows.push("", "q to close. Refreshes every " + EVERY_MS / 1000 + "s.");
  return rows.map((r) => (r.length > width ? r.slice(0, width - 1) + "…" : r)).join("\r\n");
}

function draw() {
  process.stdout.write("\x1b[H\x1b[2J" + frame() + "\r\n");
}

if (require.main === module) {
  if (process.argv.includes("--once")) {
    process.stdout.write(frame() + "\n");
  } else {
    process.stdout.write("\x1b[?25l");
    const done = () => {
      process.stdout.write("\x1b[?25h\r\n");
      process.exit(0);
    };
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (b) => {
        const k = String(b);
        if (k === "q" || k === "Q" || k === "\x03") done();
      });
    }
    process.on("SIGINT", done);
    process.stdout.on("resize", draw);
    draw();
    setInterval(draw, EVERY_MS);
  }
}

module.exports = { frame };
