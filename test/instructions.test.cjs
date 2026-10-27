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
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: path.join(home, ".jmcp"), USERPROFILE: home, HOME: home } });
  try {
    const init = await c.initialize("test");
    assert.strictEqual(init.serverInfo.name, "jmcp-instructions");
    assert.match(init.instructions, /AGENTS\.md/);
    const { tools } = await c.request("tools/list");
    assert.deepStrictEqual(tools.map((t) => t.name), ["master_instructions", "list", "read", "write", "delete"]);
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

test("master instructions: the app sets them, agents get them labeled and cannot change them", async () => {
  const home = scratch();
  const jmcp = path.join(home, ".jmcp");
  const file = ins.masterPath(home);
  assert.strictEqual(file, path.join(jmcp, "master-instructions.md"));
  assert.strictEqual(ins.list(home).master.exists, false);
  assert.strictEqual(ins.master(home), "");

  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: jmcp, USERPROFILE: home, HOME: home } });
  try {
    // Not set: no master block, and the tool says so.
    assert.doesNotMatch((await c.initialize("test")).instructions, /MASTER INSTRUCTIONS/);
    assert.match((await c.callTool("master_instructions", {})).text, /not set master instructions/);
    // An agent cannot create it.
    const made = await c.callTool("write", { path: file, content: "agent text", hash: "" });
    assert.strictEqual(made.isError, true);
    assert.match(made.text, /set by the user in the JMCP app/);
    assert.ok(!fs.existsSync(file));
  } finally {
    await c.close();
  }

  // The app sets them; replacing keeps the old copy in the trash.
  ins.write(home, file, "Always answer in English.\n", { by: "app", expectedHash: "" });
  const first = ins.read(file, home);
  ins.write(home, file, "Always answer in English.\nNever push to main.\n", { by: "app", expectedHash: first.hash });
  assert.strictEqual(ins.master(home), "Always answer in English.\nNever push to main.");
  assert.strictEqual(ins.list(home).master.exists, true);
  assert.deepStrictEqual(ins.trash(home).map((t) => [t.path, t.reason]), [[file, "replaced"]]);

  const d = connect(process.execPath, [SERVER], { env: { JMCP_HOME: jmcp, USERPROFILE: home, HOME: home } });
  try {
    const init = await d.initialize("test");
    assert.match(init.instructions, /^MASTER INSTRUCTIONS\nThe user set these master instructions in JMCP. You must follow them in every task./);
    assert.match(init.instructions, /Never push to main.\nEND OF MASTER INSTRUCTIONS\n\nUse these tools/);
    const tool = await d.callTool("master_instructions", {});
    assert.strictEqual(tool.isError, false);
    assert.match(tool.text, /^MASTER INSTRUCTIONS[^]*Never push to main.[^]*END OF MASTER INSTRUCTIONS$/);
    // Agents can read it with read, but not replace or delete it.
    const read = await d.callTool("read", { path: file });
    assert.match(read.text, /Never push to main/);
    const hash = read.text.match(/Hash: (\w+)/)[1];
    assert.strictEqual((await d.callTool("write", { path: file, content: "changed", hash })).isError, true);
    assert.strictEqual((await d.callTool("delete", { path: file })).isError, true);
    assert.match(fs.readFileSync(file, "utf8"), /Never push to main/);
    assert.match((await d.callTool("list", {})).text, /^Master instructions \(set by the user in the JMCP app, read-only for agents\): /);

    // A change made in the app reaches the running server through the tool.
    ins.write(home, file, "Use tabs.\n", { by: "app", expectedHash: ins.read(file, home).hash });
    assert.match((await d.callTool("master_instructions", {})).text, /Use tabs./);
  } finally {
    await d.close();
  }

  // Very long text is cut in the server instructions, never in the tool.
  const long = "rule ".repeat(10000) + "LAST";
  ins.write(home, file, long, { by: "app", expectedHash: ins.read(file, home).hash });
  const e = connect(process.execPath, [SERVER], { env: { JMCP_HOME: jmcp, USERPROFILE: home, HOME: home } });
  try {
    const init = await e.initialize("test");
    assert.match(init.instructions, /Cut here. Call the master_instructions tool for the rest./);
    assert.doesNotMatch(init.instructions, /LAST/);
    assert.match((await e.callTool("master_instructions", {})).text, /LAST\nEND OF MASTER INSTRUCTIONS$/);
  } finally {
    await e.close();
  }

  // The app can delete it and restore it from the trash.
  ins.remove(home, file, { by: "app" });
  assert.strictEqual(ins.master(home), "");
  const del = ins.trash(home).find((t) => t.reason === "deleted");
  ins.restore(home, del.id);
  assert.match(ins.master(home), /LAST$/);
});

test("master instructions line: added to agent files, kept there, removed with the master", async () => {
  const home = scratch();
  const jmcp = path.join(home, ".jmcp");
  const codex = path.join(home, ".codex", "AGENTS.md");
  const droid = path.join(home, ".factory", "AGENTS.md");
  const claude = path.join(home, ".claude", "CLAUDE.md");
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.mkdirSync(path.dirname(droid), { recursive: true });
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.writeFileSync(codex, "# Codex\r\nUse tabs.\r\n");
  // Droid's file is a hard link to Codex's; it must stay one.
  fs.linkSync(codex, droid);

  // Nothing happens while no master instructions are set.
  assert.deepStrictEqual(ins.syncPointers(home), { changed: [], errors: [] });
  assert.strictEqual(fs.existsSync(claude), false);

  const r = ins.write(home, ins.masterPath(home), "Call me Captain.\n", { by: "app", expectedHash: "" });
  assert.deepStrictEqual(r.pointers.errors, []);
  assert.deepStrictEqual(r.pointers.changed.sort(), [claude, codex].sort());
  const lines = (f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.includes("master_instructions"));
  // On top, once, with the file's own line endings and its text kept.
  assert.strictEqual(fs.readFileSync(codex, "utf8"), ins.POINTER + "\r\n\r\n# Codex\r\nUse tabs.\r\n");
  assert.strictEqual(fs.readFileSync(droid, "utf8"), fs.readFileSync(codex, "utf8"));
  assert.strictEqual(fs.statSync(codex).nlink, 2);
  assert.strictEqual(fs.readFileSync(claude, "utf8"), ins.POINTER + "\n");
  // Agents whose folder is not on this computer get no file.
  assert.strictEqual(fs.existsSync(path.join(home, ".qwen")), false);
  assert.strictEqual(fs.existsSync(path.join(home, ".gemini")), false);
  // The changed file was kept in the trash first, marked as done by JMCP.
  assert.deepStrictEqual(ins.trash(home).filter((t) => t.by === "jmcp").map((t) => t.path), [codex]);
  assert.deepStrictEqual(ins.syncPointers(home), { changed: [], errors: [] });

  // An agent rewrites its file without the line; the next session start puts it back.
  ins.write(home, claude, "# Claude\n", { by: "agent", expectedHash: ins.read(claude, home).hash });
  assert.deepStrictEqual(lines(claude), []);
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: jmcp, USERPROFILE: home, HOME: home } });
  try {
    await c.initialize("test");
  } finally {
    await c.close();
  }
  assert.strictEqual(fs.readFileSync(claude, "utf8"), ins.POINTER + "\n\n# Claude\n");

  // Two copies, or an old version of the line, become one current line.
  fs.writeFileSync(claude, "<!-- JMCP master instructions: old -->\n# Claude\n" + ins.POINTER + "\n");
  assert.deepStrictEqual(ins.syncPointers(home).changed, [claude]);
  assert.strictEqual(fs.readFileSync(claude, "utf8"), ins.POINTER + "\n\n# Claude\n");

  // Deleting the master takes the line out again and leaves the rest.
  const del = ins.remove(home, ins.masterPath(home), { by: "app" });
  assert.deepStrictEqual(del.pointers.changed.sort(), [claude, codex].sort());
  assert.strictEqual(fs.readFileSync(codex, "utf8"), "# Codex\r\nUse tabs.\r\n");
  assert.strictEqual(fs.readFileSync(droid, "utf8"), "# Codex\r\nUse tabs.\r\n");
  assert.strictEqual(fs.statSync(droid).nlink, 2);
  assert.strictEqual(fs.readFileSync(claude, "utf8"), "# Claude\n");

  // A file that only held the line is removed with it.
  ins.write(home, ins.masterPath(home), "x", { by: "app", expectedHash: "" });
  fs.writeFileSync(claude, ins.POINTER + "\n");
  ins.remove(home, ins.masterPath(home), { by: "app" });
  assert.strictEqual(fs.existsSync(claude), false);

  // A server on another JMCP home with no master never removes lines.
  fs.writeFileSync(claude, ins.POINTER + "\n");
  assert.deepStrictEqual(ins.syncPointers(home, { addOnly: true }), { changed: [], errors: [] });
  assert.strictEqual(fs.readFileSync(claude, "utf8"), ins.POINTER + "\n");
});

test("long master instructions that have not changed come back as one line until full is asked", async () => {
  const home = scratch();
  const jmcp = path.join(home, ".jmcp");
  const file = ins.masterPath(home);
  ins.write(home, file, "Keep replies short. ".repeat(40) + "LAST", { by: "app", expectedHash: "" });
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: jmcp, USERPROFILE: home, HOME: home } });
  try {
    await c.initialize("test");
    assert.match((await c.callTool("master_instructions", {})).text, /LAST/);
    const again = (await c.callTool("master_instructions", {})).text;
    assert.match(again, /have not changed since you last called/);
    assert.doesNotMatch(again, /LAST/);
    assert.match((await c.callTool("master_instructions", { full: true })).text, /LAST/);
    ins.write(home, file, "Use tabs. ".repeat(60), { by: "app", expectedHash: ins.read(file, home).hash });
    assert.match((await c.callTool("master_instructions", {})).text, /Use tabs/);
  } finally {
    await c.close();
  }
  // Short text is always sent whole.
  ins.write(home, file, "Be brief.", { by: "app", expectedHash: ins.read(file, home).hash });
  const d = connect(process.execPath, [SERVER], { env: { JMCP_HOME: jmcp, USERPROFILE: home, HOME: home } });
  try {
    await d.initialize("test");
    await d.callTool("master_instructions", {});
    assert.match((await d.callTool("master_instructions", {})).text, /Be brief/);
  } finally {
    await d.close();
  }
});
