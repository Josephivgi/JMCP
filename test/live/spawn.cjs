"use strict";

// Live: start a real subagent through jmcp-subagents, the way an agent would.
//   node test/live/spawn.cjs <provider> [scratch-folder]
// It asks for PONG and prints status, model and reply. Uses your real sign-ins.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { connect } = require("../../core/mcp-client.cjs");

(async () => {
  const provider = process.argv[2] || "droid";
  const dir = path.resolve(process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "jmcp-live-")));
  fs.mkdirSync(dir, { recursive: true });
  const c = connect(process.execPath, [path.join(__dirname, "..", "..", "servers", "subagents", "server.cjs")], { env: { JMCP_HOME: path.join(dir, "home"), JMCP_SUBAGENT: "" } });
  await c.initialize("jmcp-live-test");
  const t0 = Date.now();
  const r = await c.callTool("spawn", { provider, task: "Reply with exactly the word PONG and nothing else. Do not use any tools.", cwd: dir, timeout_seconds: 300 });
  const j = r.json || {};
  console.log(provider, Math.round((Date.now() - t0) / 1000) + "s", r.isError ? "ERROR " + r.text : JSON.stringify({ status: j.status, model: j.model, reply: j.reply, error: j.error }));
  await c.close();
  process.exit(!r.isError && /PONG/.test(j.reply || "") ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
