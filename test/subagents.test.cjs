"use strict";

// The subagents server over real stdio. No agent is started here; the live
// runs (real Droid, Devin, Grok, Claude Code) are in test/live/.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { connect } = require("../core/mcp-client.cjs");

const SERVER = path.join(__dirname, "..", "servers", "subagents", "server.cjs");
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "jmcp-sub-"));

test("lists its tools", async () => {
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: home(), JMCP_SUBAGENT: "" } });
  const init = await c.initialize("test");
  assert.strictEqual(init.serverInfo.name, "jmcp-subagents");
  const { tools } = await c.request("tools/list");
  assert.deepStrictEqual(tools.map((t) => t.name), ["providers", "spawn", "workflow", "workflow_status", "list", "wait", "send", "read", "stop"]);
  await c.close();
});

test("inside a subagent it offers no tools", async () => {
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: home(), JMCP_SUBAGENT: "droid-1" } });
  const init = await c.initialize("droid");
  assert.match(init.instructions, /cannot start subagents/);
  assert.deepStrictEqual((await c.request("tools/list")).tools, []);
  const r = await c.callTool("spawn", { provider: "claude", task: "x" });
  assert.ok(r.isError);
  await c.close();
});

test("rejects bad spawns and workflows before starting anything", async () => {
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: home(), JMCP_SUBAGENT: "" } });
  await c.initialize("test");
  assert.match((await c.callTool("spawn", { provider: "nope", task: "x" })).text, /Unknown provider/);
  assert.match((await c.callTool("spawn", { provider: "claude", task: " " })).text, /task is empty/);
  const loop = await c.callTool("workflow", { steps: [{ id: "a", provider: "claude", task: "x", after: ["b"] }, { id: "b", provider: "claude", task: "y", after: ["a"] }] });
  assert.ok(loop.isError);
  assert.match(loop.text, /loop/);
  assert.match((await c.callTool("workflow", { steps: [{ id: "a", provider: "claude", task: "x", after: ["zzz"] }] })).text, /unknown step/);
  assert.match((await c.callTool("wait", { agent: "droid-9" })).text, /No subagent/);
  await c.close();
});
