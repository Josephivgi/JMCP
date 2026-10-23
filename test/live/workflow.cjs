"use strict";

// Live: a three-step workflow across providers. Droid reads a file and Devin
// does a sum at the same time, then Grok adds their replies.
//   node test/live/workflow.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { connect } = require("../../core/mcp-client.cjs");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jmcp-wf-"));
  fs.writeFileSync(path.join(dir, "note.txt"), "the secret number is 4817\n");
  const c = connect(process.execPath, [path.join(__dirname, "..", "..", "servers", "subagents", "server.cjs")], { env: { JMCP_HOME: path.join(dir, "home"), JMCP_SUBAGENT: "" }, cwd: dir });
  await c.initialize("jmcp-live-test");
  const r = await c.callTool("workflow", {
    cwd: dir,
    timeout_seconds: 600,
    steps: [
      { id: "a", provider: "droid", task: "Read note.txt. Reply with only the number in it." },
      { id: "b", provider: "devin", task: "Reply with only the result of 6*7." },
      { id: "sum", provider: "grok", after: ["a", "b"], task: "Add these two numbers and reply with only the sum: {{a}} and {{b}}" },
    ],
  });
  console.log(r.isError ? r.text : JSON.stringify(r.json, null, 1));
  await c.close();
  process.exit(r.json && r.json.status === "done" && /4859/.test(r.json.steps[2].reply || "") ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
