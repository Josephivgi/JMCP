"use strict";

// The subagents server over real stdio. No agent is started here; the live
// run (a real subagent) is test/live/spawn.cjs.

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
  assert.deepStrictEqual(tools.map((t) => t.name), ["providers", "spawn", "list", "wait", "send", "read", "stop"]);
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

test("rejects bad spawns before starting anything", async () => {
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: home(), JMCP_SUBAGENT: "" } });
  await c.initialize("test");
  assert.match((await c.callTool("spawn", { provider: "nope", task: "x" })).text, /Unknown provider/);
  assert.match((await c.callTool("spawn", { provider: "claude", task: " " })).text, /task is empty/);
  assert.match((await c.callTool("workflow", { steps: [] })).text, /Unknown tool/);
  assert.match((await c.callTool("wait", { agent: "droid-9" })).text, /No subagent/);
  await c.close();
});
