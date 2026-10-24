"use strict";

// Instruction files, their trash and the jmcp-instructions server, on scratch homes.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ins = require("../core/instructions.cjs");
const catalog = require("../core/catalog.cjs");
const agents = require("../core/agents.cjs");
const { connect } = require("../core/mcp-client.cjs");

const SERVER = path.join(__dirname, "..", "servers", "instructions", "server.cjs");
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "jmcp-ins-"));

test("only instruction file names, absolute paths", () => {
  const home = scratch();
  assert.throws(() => ins.read("AGENTS.md"), /absolute/);
  assert.throws(() => ins.read(path.join(home, "notes.md")), /Only AGENTS.md/);
  assert.throws(() => ins.write(home, path.join(home, "settings.json"), "{}"), /Only AGENTS.md/);
  assert.throws(() => ins.remove(home, path.join(home, ".ssh", "id_rsa")), /Only AGENTS.md/);
  assert.strictEqual(ins.checkPath(path.join(home, "agents.md")), path.join(home, "AGENTS.md"));
});

test("agent files, folders, write, delete and restore", () => {
  const home = scratch();
  const listed = ins.list(home);
  assert.strictEqual(listed.agents.length, 8);
  assert.ok(listed.agents.every((f) => !f.exists && f.path.startsWith(home)));
  assert.deepStrictEqual(listed.folders, []);

  const codex = path.join(home, ".codex", "AGENTS.md");
  const made = ins.write(home, codex, "# Codex\n", { expectedHash: "" });
  assert.strictEqual(made.created, true);
  assert.strictEqual(ins.list(home).agents.find((f) => f.agent === "Codex").exists, true);
  assert.deepStrictEqual(ins.trash(home), []);

  const first = ins.read(codex);
  assert.strictEqual(first.text, "# Codex\n");
  assert.throws(() => ins.write(home, codex, "x", { expectedHash: "stale" }), /changed on disk/);
  const saved = ins.write(home, codex, "# Codex v2\n", { expectedHash: first.hash, by: "agent" });
  assert.strictEqual(saved.changed, true);
  assert.strictEqual(ins.write(home, codex, "# Codex v2\n").changed, false);
  let trash = ins.trash(home);
  assert.strictEqual(trash.length, 1);
  assert.strictEqual(trash[0].reason, "replaced");
  assert.strictEqual(trash[0].by, "agent");
  assert.strictEqual(ins.trashText(home, trash[0].id), "# Codex\n");

  const project = path.join(home, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "AGENTS.md"), "line one\r\nline two\r\n");
  fs.writeFileSync(path.join(project, "README.md"), "not listed");
  assert.throws(() => ins.addFolder(home, path.join(home, "nope")), /No folder/);
  ins.addFolder(home, project);
  ins.addFolder(home, project);
  const folder = ins.list(home).folders;
  assert.strictEqual(folder.length, 1);
  assert.deepStrictEqual(folder[0].files.map((f) => f.name), ["AGENTS.md"]);
  // A textarea gives \n; the file keeps \r\n.
  ins.write(home, path.join(project, "AGENTS.md"), "line one\nline 2\n");
  assert.strictEqual(fs.readFileSync(path.join(project, "AGENTS.md"), "utf8"), "line one\r\nline 2\r\n");

  const gone = ins.remove(home, codex, { by: "app" });
  assert.ok(!fs.existsSync(codex));
  assert.throws(() => ins.remove(home, codex), /No file/);
  trash = ins.trash(home);
  assert.strictEqual(trash[0].id, gone.trashId);
  assert.strictEqual(trash[0].reason, "deleted");
  ins.restore(home, gone.trashId);
  assert.strictEqual(fs.readFileSync(codex, "utf8"), "# Codex v2\n");
  assert.ok(!ins.trash(home).some((t) => t.id === gone.trashId));

  const old = ins.trash(home).find((t) => t.path === codex);
  ins.restore(home, old.id);
  assert.strictEqual(fs.readFileSync(codex, "utf8"), "# Codex\n");
  // The file it replaced is kept, so the restore can be undone.
  assert.strictEqual(ins.trashText(home, ins.trash(home).find((t) => t.path === codex).id), "# Codex v2\n");

  const anyId = ins.trash(home)[0].id;
  assert.strictEqual(ins.forget(home, anyId), true);
  assert.throws(() => ins.trashText(home, anyId), /no longer/);
  assert.strictEqual(ins.removeFolder(home, project), true);
  assert.deepStrictEqual(ins.list(home).folders, []);
  assert.ok(fs.existsSync(path.join(project, "AGENTS.md")));
});

test("catalog installs jmcp-instructions", async () => {
  const home = scratch();
  const item = catalog.catalogItem("instructions");
  assert.deepStrictEqual(item.tools, ["list", "read", "write", "delete"]);
  const r = await catalog.installServer("instructions", ["claude-code", "codex"], home);
  assert.ok(r.results.every((x) => x.ok));
  const s = agents.scan(home).find((a) => a.id === "codex").servers.find((x) => x.name === "jmcp-instructions");
  assert.deepStrictEqual(s.args, [path.join(home, ".jmcp", "servers", "instructions", "server.cjs")]);
  assert.ok(fs.existsSync(path.join(home, ".jmcp", "servers", "instructions", "lib", "store.js")));
});

test("stdio server lists, reads, writes and deletes", async () => {
  const home = scratch();
  const project = path.join(home, "proj");
  fs.mkdirSync(project);
  const file = path.join(project, "AGENTS.md");
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: path.join(home, ".jmcp") } });
  try {
    const init = await c.initialize("test");
    assert.strictEqual(init.serverInfo.name, "jmcp-instructions");
    assert.match(init.instructions, /AGENTS\.md/);
    const { tools } = await c.request("tools/list");
    assert.deepStrictEqual(tools.map((t) => t.name), ["list", "read", "write", "delete"]);
    assert.match((await c.callTool("list", { folder: project })).text, /no instruction files/);
    const made = await c.callTool("write", { path: file, content: "# Proj\n", hash: "" });
    assert.strictEqual(made.isError, false);
    assert.match(made.text, /^Created /);
    const read = await c.callTool("read", { path: file });
    const hash = read.text.match(/Hash: (\w+)/)[1];
    assert.match(read.text, /# Proj/);
    assert.strictEqual((await c.callTool("write", { path: file, content: "x", hash: "bad" })).isError, true);
    assert.match((await c.callTool("write", { path: file, content: "# Proj 2\n", hash })).text, /^Saved /);
    assert.strictEqual((await c.callTool("write", { path: path.join(project, "x.json"), content: "{}" })).isError, true);
    assert.match((await c.callTool("delete", { path: file })).text, /JMCP trash/);
    assert.ok(!fs.existsSync(file));
    const trash = ins.trash(home);
    assert.deepStrictEqual(trash.map((t) => [t.reason, t.by]).sort(), [["deleted", "agent"], ["replaced", "agent"]]);
    await assert.rejects(c.callTool("nope"), /Unknown tool nope/);
  } finally {
    await c.close();
  }
});

test("a write with no hash never replaces a file that exists", () => {
  const home = scratch();
  const file = path.join(home, "p", "AGENTS.md");
  ins.write(home, file, "mine\n", { expectedHash: "" });
  assert.throws(() => ins.write(home, file, "theirs\n", { expectedHash: "" }), /already exists[\s\S]*Read it first/);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "mine\n");
  const h = ins.read(file).hash;
  fs.rmSync(file);
  assert.throws(() => ins.write(home, file, "x", { expectedHash: h }), /no longer exists/);
});

test("Claude Code rules files in ~/.claude/rules can be listed, read and written", () => {
  const home = scratch();
  const dir = path.join(home, ".claude", "rules");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "default.md"), "- Be concise.\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a rule");
  assert.deepStrictEqual(ins.list(home).rules.map((f) => f.name), ["default.md"]);
  const r = ins.read(path.join(dir, "default.md"), home);
  assert.strictEqual(r.text, "- Be concise.\n");
  assert.strictEqual(ins.write(home, path.join(dir, "default.md"), "- Be brief.\n", { expectedHash: r.hash }).changed, true);
  assert.strictEqual(ins.write(home, path.join(dir, "new-rule.md"), "- New.\n", { expectedHash: "" }).created, true);
  assert.throws(() => ins.read(path.join(dir, "notes.txt"), home), /Only AGENTS.md/);
  assert.throws(() => ins.write(home, path.join(dir, "sub", "x.md"), "x", { expectedHash: "" }), /Only AGENTS.md/);
  assert.throws(() => ins.write(home, path.join(home, "other", "x.md"), "x", { expectedHash: "" }), /Only AGENTS.md/);
});

test("stdio server: no-hash writes cannot replace files; list shows rules and found folders", async () => {
  const home = scratch();
  fs.mkdirSync(path.join(home, ".claude", "rules"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "rules", "style.md"), "- No em-dashes.\n");
  fs.writeFileSync(path.join(home, "AGENTS.md"), "# Home\n");
  const file = path.join(home, "proj", "CLAUDE.md");
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: path.join(home, ".jmcp"), USERPROFILE: home, HOME: home } });
  try {
    await c.initialize("test");
    assert.match((await c.callTool("write", { path: file, content: "a\n" })).text, /^Created /);
    const again = await c.callTool("write", { path: file, content: "b\n" });
    assert.strictEqual(again.isError, true);
    assert.match(again.text, /already exists/);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "a\n");
    const list = (await c.callTool("list")).text;
    assert.match(list, /Claude Code rules[\s\S]*style\.md/);
    assert.match(list, /found, not saved[\s\S]*AGENTS\.md/);
  } finally {
    await c.close();
  }
});

test("writes never go through a leftover temp file, links or a linked rules folder", () => {
  const home = scratch();
  const project = path.join(home, "p");
  fs.mkdirSync(project);
  const victim = path.join(home, "victim.json");
  fs.writeFileSync(victim, "{}");
  // An old fixed temp name, hard-linked to another file, must not be written through.
  fs.linkSync(victim, path.join(project, "GEMINI.md.jmcp-tmp"));
  ins.write(home, path.join(project, "GEMINI.md"), "# G\n", { expectedHash: "" });
  assert.strictEqual(fs.readFileSync(victim, "utf8"), "{}");
  assert.deepStrictEqual(fs.readdirSync(project).filter((f) => /\.jmcp-tmp$/.test(f) && f !== "GEMINI.md.jmcp-tmp"), []);

  // A rules folder that is a junction to somewhere else is refused.
  const outside = path.join(home, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "notes.md"), "outside\n");
  fs.mkdirSync(path.join(home, ".claude"));
  fs.symlinkSync(outside, path.join(home, ".claude", "rules"), "junction");
  assert.throws(() => ins.read(path.join(home, ".claude", "rules", "notes.md"), home), /is a link to another folder/);
  assert.throws(() => ins.write(home, path.join(home, ".claude", "rules", "notes.md"), "x", { expectedHash: "" }), /is a link to another folder/);
  assert.strictEqual(fs.readFileSync(path.join(outside, "notes.md"), "utf8"), "outside\n");

  // A linked ~/.claude with no rules folder yet cannot make one elsewhere.
  const home2 = scratch();
  const elsewhere = path.join(home2, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(home2, ".claude"), "junction");
  assert.throws(() => ins.write(home2, path.join(home2, ".claude", "rules", "style.md"), "x", { expectedHash: "" }), /is a link to another folder/);
  assert.ok(!fs.existsSync(path.join(elsewhere, "rules")));
});

test("trash ids are checked, large deletes can be restored, CRLF growth is counted", () => {
  const home = scratch();
  const jm = path.join(home, ".jmcp");
  fs.mkdirSync(jm, { recursive: true });
  fs.writeFileSync(path.join(jm, "outside.md"), "keep me");
  assert.strictEqual(ins.forget(home, "../outside"), false);
  assert.ok(fs.existsSync(path.join(jm, "outside.md")));

  const big = path.join(home, "big", "CLAUDE.md");
  fs.mkdirSync(path.dirname(big));
  fs.writeFileSync(big, "x".repeat(1024 * 1024 + 10));
  const { trashId } = ins.remove(home, big);
  ins.restore(home, trashId);
  assert.strictEqual(fs.statSync(big).size, 1024 * 1024 + 10);

  const crlf = path.join(home, "crlf", "AGENTS.md");
  fs.mkdirSync(path.dirname(crlf));
  fs.writeFileSync(crlf, "a\r\nb\r\n");
  const h = ins.read(crlf).hash;
  assert.throws(() => ins.write(home, crlf, "\n".repeat(600000), { expectedHash: h }), /once its line endings match/);
});
