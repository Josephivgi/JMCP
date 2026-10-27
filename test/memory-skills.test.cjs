"use strict";

// jmcp-memory and jmcp-skills: their stores, stdio servers, catalog entries
// and CLI, on scratch homes.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const memory = require("../core/memory.cjs");
const skills = require("../core/skills.cjs");
const catalog = require("../core/catalog.cjs");
const agents = require("../core/agents.cjs");
const { connect } = require("../core/mcp-client.cjs");

const MEMORY = path.join(__dirname, "..", "servers", "memory", "server.cjs");
const SKILLS = path.join(__dirname, "..", "servers", "skills", "server.cjs");
const CLI = path.join(__dirname, "..", "cli", "jmcp.cjs");
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "jmcp-lib-"));

test("memory save, replace, update, search and delete", () => {
  const home = scratch();
  assert.deepStrictEqual(memory.list(home), []);
  assert.throws(() => memory.save(home, { title: " ", body: "x" }), /title must not be empty/);
  assert.throws(() => memory.save(home, { title: "x", body: "" }), /body must not be empty/);
  assert.throws(() => memory.save(home, { title: "x", body: "y".repeat(memory.MAX_BODY + 1) }), /longer than/);
  const a = memory.save(home, { title: "Prefers SQLite!", body: "Use SQLite for local apps.", tags: ["Data", "data", "windows"], author: "claude-code" });
  assert.strictEqual(a.created, true);
  assert.strictEqual(a.memory.name, "prefers-sqlite");
  assert.deepStrictEqual(a.memory.tags, ["data", "windows"]);
  assert.strictEqual(a.memory.author, "claude-code");
  const again = memory.save(home, { name: "Prefers SQLite", title: "Prefers SQLite", body: "SQLite, never localStorage.", author: "codex" });
  assert.strictEqual(again.created, false);
  assert.strictEqual(again.memory.id, a.memory.id);
  assert.strictEqual(memory.list(home).length, 1);
  memory.save(home, { title: "No windows on desktop", body: "Run commands hidden.", tags: "windows, ui" });
  // The replace dropped the tags, so only the new memory is about windows.
  assert.deepStrictEqual(memory.search(home, "windows").map((m) => m.name), ["no-windows-on-desktop"]);
  memory.save(home, { title: "Hidden consoles", body: "Child processes on windows start hidden." });
  assert.deepStrictEqual(memory.search(home, "windows").map((m) => m.name), ["no-windows-on-desktop", "hidden-consoles"]);
  assert.deepStrictEqual(memory.search(home, "sqlite localstorage").map((m) => m.name), ["prefers-sqlite"]);
  assert.deepStrictEqual(memory.search(home, "nothing here"), []);
  assert.throws(() => memory.update(home, a.memory.id, { name: "no-windows-on-desktop" }), /already named/);
  const edited = memory.update(home, a.memory.id, { title: "SQLite", tags: [] });
  assert.strictEqual(edited.author, "JMCP app");
  assert.deepStrictEqual(edited.tags, []);
  assert.strictEqual(memory.update(home, "missing", { title: "x" }), null);
  assert.strictEqual(memory.get(home, "prefers-sqlite").title, "SQLite");
  assert.match(memory.index(memory.list(home)), /- prefers-sqlite: SQLite/);
  assert.strictEqual(memory.remove(home, "prefers-sqlite"), true);
  assert.strictEqual(memory.remove(home, "prefers-sqlite"), false);
});

test("memory server: agents save, search, read and delete through MCP", async () => {
  const home = scratch();
  memory.save(home, { title: "Uses Windows", body: "Windows 11 Home." });
  const c = connect(process.execPath, [MEMORY], { env: { JMCP_HOME: path.join(home, ".jmcp") } });
  try {
    const init = await c.initialize("droid-test");
    assert.strictEqual(init.serverInfo.name, "jmcp-memory");
    assert.match(init.instructions, /- uses-windows: Uses Windows/);
    const { tools } = await c.request("tools/list");
    assert.deepStrictEqual(tools.map((t) => t.name), ["memory_search", "memory_read", "memory_save", "memory_delete"]);
    const saved = await c.callTool("memory_save", { title: "Ships to origin", body: "Commit and push verified work.", tags: ["git"] });
    assert.strictEqual(saved.isError, false);
    assert.match(saved.text, /Saved new memory ships-to-origin/);
    assert.strictEqual(memory.get(home, "ships-to-origin").author, "droid-test");
    assert.match((await c.callTool("memory_search", { query: "push" })).text, /ships-to-origin/);
    assert.match((await c.callTool("memory_read", { name: "ships-to-origin" })).text, /saved by droid-test[\s\S]*Commit and push/);
    assert.strictEqual((await c.callTool("memory_read", { name: "nope" })).isError, true);
    assert.strictEqual((await c.callTool("memory_save", { title: "x" })).isError, true);
    assert.match((await c.callTool("memory_delete", { name: "ships-to-origin" })).text, /Deleted/);
    assert.strictEqual(memory.get(home, "ships-to-origin"), null);
  } finally {
    await c.close();
  }
});

test("SKILL.md front matter: quoted, plain, folded and missing", () => {
  assert.deepStrictEqual(skills.parseSkillMd('---\nname: a-b\ndescription: "Say \\"hi\\"."\n---\n\n# Body\n'), { meta: { name: "a-b", description: 'Say "hi".' }, body: "# Body" });
  assert.strictEqual(skills.parseSkillMd("---\r\nname: x\r\ndescription: >\r\n  one\r\n  two\r\n---\r\nB").meta.description, "one two");
  assert.strictEqual(skills.parseSkillMd("---\nname: x\ndescription: 'It''s'\n---\nB").meta.description, "It's");
  assert.strictEqual(skills.parseSkillMd("---\nname: x\ndescription: long\n  continued\n---\nB").meta.description, "long continued");
  assert.deepStrictEqual(skills.parseSkillMd("# Just a body"), { meta: {}, body: "# Just a body" });
});

function writeSkill(dir, name, description, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: " + name + "\ndescription: " + description + "\n---\n\n" + body + "\n");
}

test("skills CRUD, import from agent folders and support files", () => {
  const home = scratch();
  assert.throws(() => skills.add(home, { name: "x", description: "", body: "b" }), /description must not be empty/);
  const made = skills.add(home, { name: "Release Notes", description: "Use for release notes.", body: "Write for users." });
  assert.strictEqual(made.name, "release-notes");
  assert.strictEqual(made.enabled, true);
  assert.throws(() => skills.add(home, { name: "release-notes", description: "d", body: "b" }), /already exists/);
  writeSkill(path.join(home, ".claude", "skills", "synced", "abc", "pdf"), "pdf", "Use for PDF files.", "Read PDFs.");
  fs.writeFileSync(path.join(home, ".claude", "skills", "synced", "abc", "pdf", "helper.py"), "print(1)\n");
  writeSkill(path.join(home, ".codex", "skills", "release-notes"), "release-notes", "Other notes.", "Other.");
  fs.mkdirSync(path.join(home, ".grok", "skills", "broken"), { recursive: true });
  fs.writeFileSync(path.join(home, ".grok", "skills", "broken", "SKILL.md"), "---\nname: broken\n---\nNo description.");
  const found = skills.importable(home);
  const by = (n) => found.find((f) => f.name === n);
  assert.strictEqual(by("pdf").state, "new");
  assert.strictEqual(by("pdf").agent, "Claude Code");
  assert.strictEqual(by("release-notes").state, "taken");
  const r = skills.importFiles(home, found.map((f) => f.file));
  assert.deepStrictEqual(r.map((x) => [x.name, x.ok]), found.map((f) => [f.name, f.name === "pdf"]));
  assert.match(r.find((x) => x.name === "broken").error, /no description/);
  const pdf = skills.get(home, "pdf");
  assert.strictEqual(pdf.origin, by("pdf").file);
  assert.deepStrictEqual(skills.supportFiles(pdf).map((f) => path.basename(f)), ["helper.py"]);
  assert.strictEqual(skills.importable(home).find((f) => f.name === "pdf").state, "imported");
  writeSkill(path.dirname(pdf.origin), "pdf", "Use for any PDF.", "Read PDFs well.");
  assert.strictEqual(skills.importFiles(home, [pdf.origin])[0].updated, true);
  assert.strictEqual(skills.get(home, "pdf").body, "Read PDFs well.");
  skills.update(home, made.id, { enabled: false });
  assert.deepStrictEqual(skills.active(home).map((s) => s.name), ["pdf"]);
  assert.throws(() => skills.update(home, made.id, { name: "pdf" }), /already exists/);
  assert.strictEqual(skills.remove(home, made.id), true);
});

test("skills server lists only skills that are on and loads them", async () => {
  const home = scratch();
  skills.add(home, { name: "deploy", description: "Use before deploying.", body: "Check CI first." });
  const off = skills.add(home, { name: "hidden", description: "Off skill.", body: "Secret." });
  skills.update(home, off.id, { enabled: false });
  const c = connect(process.execPath, [SKILLS], { env: { JMCP_HOME: path.join(home, ".jmcp") } });
  try {
    const init = await c.initialize("test");
    assert.strictEqual(init.serverInfo.name, "jmcp-skills");
    assert.match(init.instructions, /- deploy: Use before deploying\./);
    assert.ok(!init.instructions.includes("hidden"));
    const { tools } = await c.request("tools/list");
    assert.deepStrictEqual(tools.map((t) => t.name), ["skills_list", "skill_read", "skill_save"]);
    assert.strictEqual((await c.callTool("skills_list")).text, "- deploy: Use before deploying.");
    assert.match((await c.callTool("skill_read", { name: "deploy" })).text, /# Skill: deploy[\s\S]*Check CI first\./);
    assert.strictEqual((await c.callTool("skill_read", { name: "hidden" })).isError, true);
    skills.add(home, { name: "late", description: "Added while running.", body: "Hi." });
    assert.match((await c.callTool("skills_list")).text, /- late:/);
  } finally {
    await c.close();
  }
});

test("catalog installs memory and skills into agents; CLI lists them", async () => {
  const home = scratch();
  for (const id of ["memory", "skills"]) {
    const r = await catalog.installServer(id, ["claude-code", "codex"], home);
    assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
    for (const a of ["claude-code", "codex"]) {
      const s = agents.scan(home).find((x) => x.id === a).servers.find((x) => x.name === "jmcp-" + id);
      assert.deepStrictEqual(s.args, [path.join(home, ".jmcp", "servers", id, "server.cjs")]);
    }
    assert.ok(fs.existsSync(path.join(home, ".jmcp", "servers", id, "lib", "store.js")));
  }
  memory.save(home, { title: "A fact", body: "B" });
  skills.add(home, { name: "s1", description: "D1", body: "B" });
  const cli = (...args) => execFileSync(process.execPath, [CLI, ...args, "--home", home], { encoding: "utf8", windowsHide: true });
  assert.match(cli("memory", "list"), /^a-fact  A fact  \(JMCP app\)$/m);
  assert.match(cli("skills", "list"), /^s1  D1$/m);
  assert.deepStrictEqual(JSON.parse(cli("skills", "list", "--json")).map((s) => s.name), ["s1"]);
});

test("installAll puts every JMCP server in every found agent and skips ones already there", async () => {
  const home = scratch();
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
  const found = agents.scan(home).filter((a) => a.present).map((a) => a.id);
  assert.ok(found.includes("codex") && found.includes("grok"), found.join(","));
  await catalog.installServer("rules", ["codex"], home);
  const r = await catalog.installAll(home);
  assert.ok(r.every((s) => s.ok), JSON.stringify(r));
  assert.deepStrictEqual(r.find((s) => s.server === "jmcp-rules").results.map((x) => x.agent).sort(), found.filter((a) => a !== "codex").sort());
  for (const c of catalog.catalogState(home)) assert.deepStrictEqual(c.installedIn.sort(), found.slice().sort(), c.name);
  assert.deepStrictEqual(await catalog.installAll(home), []);
});

test("instruction folders are detected from agent history and home, and can be hidden", () => {
  const instructions = require("../core/instructions.cjs");
  const home = scratch();
  const mk = (rel, name) => {
    fs.mkdirSync(path.join(home, rel), { recursive: true });
    fs.writeFileSync(path.join(home, rel, name), "# x\n");
    return path.join(home, rel);
  };
  const api = mk("work/api", "CLAUDE.md");
  const demo = mk("Projects/demo", "AGENTS.md");
  mk("AppData/Local/Temp/junk", "AGENTS.md");
  fs.mkdirSync(path.join(home, "Projects", "empty"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: { [api.split(path.sep).join("/")]: {}, [path.join(home, "AppData/Local/Temp/junk")]: {} } }));
  const sess = path.join(home, ".codex", "sessions", "2026", "10", "23");
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(path.join(sess, "rollout-1.jsonl"), JSON.stringify({ type: "session_meta", payload: { cwd: demo } }) + "\n");
  const got = instructions.detectFolders(home).map((d) => d.path).sort();
  assert.deepStrictEqual(got, [demo, api].sort());
  assert.deepStrictEqual(instructions.detectFolders(home).find((d) => d.path === api).files.map((f) => f.name), ["CLAUDE.md"]);
  instructions.addFolder(home, api);
  assert.deepStrictEqual(instructions.detectFolders(home).map((d) => d.path), [demo]);
  instructions.removeFolder(home, demo);
  assert.deepStrictEqual(instructions.detectFolders(home), []);
  instructions.addFolder(home, demo);
  assert.ok(instructions.folders(home).includes(demo));
});

test("memory server refuses secrets", async () => {
  const home = scratch();
  const c = connect(process.execPath, [MEMORY], { env: { JMCP_HOME: path.join(home, ".jmcp") } });
  try {
    await c.initialize("test");
    for (const body of ["key sk-ant-api03-" + "a".repeat(40), "token ghp_" + "b".repeat(36), "-----BEGIN OPENSSH PRIVATE KEY-----\nabc", "password: hunter2hunter2", "AKIA" + "ABCDEFGHIJKLMNOP"]) {
      const r = await c.callTool("memory_save", { title: "x", body });
      assert.strictEqual(r.isError, true, body);
      assert.match(r.text, /never put secrets/);
    }
    assert.deepStrictEqual(memory.list(home), []);
    assert.strictEqual((await c.callTool("memory_save", { title: "Deploy key", body: "The deploy key is in 1Password under Servers." })).isError, false);
  } finally {
    await c.close();
  }
});

test("skills server: agents create and replace their own skills, not imported ones", async () => {
  const home = scratch();
  const src = path.join(home, "skills", "imported", "SKILL.md");
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, "---\nname: imported\ndescription: From a file.\n---\nBody.");
  skills.importFiles(home, [src]);
  const c = connect(process.execPath, [SKILLS], { env: { JMCP_HOME: path.join(home, ".jmcp") } });
  try {
    await c.initialize("test");
    const { tools } = await c.request("tools/list");
    assert.deepStrictEqual(tools.map((t) => t.name), ["skills_list", "skill_read", "skill_save"]);
    assert.match((await c.callTool("skill_save", { name: "Release Notes", description: "Use when writing release notes.", instructions: "Group by New, Improved, Fixed." })).text, /Saved new skill release-notes/);
    assert.match((await c.callTool("skill_read", { name: "release-notes" })).text, /Group by New/);
    assert.match((await c.callTool("skill_save", { name: "release-notes", description: "Use for release notes.", instructions: "v2" })).text, /Replaced skill release-notes/);
    assert.strictEqual(skills.get(home, "release-notes").body, "v2");
    const blocked = await c.callTool("skill_save", { name: "imported", description: "x", instructions: "y" });
    assert.strictEqual(blocked.isError, true);
    assert.match(blocked.text, /Edit that SKILL\.md/);
    assert.strictEqual((await c.callTool("skill_save", { name: "x", description: "", instructions: "y" })).isError, true);
  } finally {
    await c.close();
  }
});

test("a name that equals another memory's id deletes only the named one", () => {
  const home = scratch();
  const a = memory.save(home, { title: "A", body: "first" }).memory;
  memory.save(home, { name: a.id, title: "B", body: "second" });
  const named = memory.list(home).find((m) => m.title === "B").name;
  assert.strictEqual(memory.remove(home, named, { byName: true }), true);
  assert.deepStrictEqual(memory.list(home).map((m) => m.title), ["A"]);
  assert.strictEqual(memory.get(home, a.id).title, "A");
});

test("skills index is bounded", () => {
  const list = Array.from({ length: 250 }, (_, i) => ({ name: "s" + i, description: "d".repeat(1000) }));
  const text = skills.index(list, 60);
  assert.strictEqual(text.split("\n").length, 61);
  assert.match(text, /and 190 more/);
  assert.ok(text.split("\n")[0].length < 420);
});

test("short passwords are refused; placeholders are not", () => {
  const { findSecret } = require("../servers/memory/lib/store.js");
  assert.ok(findSecret("password: hunter2"));
  assert.ok(findSecret("pwd=abcd"));
  assert.strictEqual(findSecret("password: none"), "");
  assert.strictEqual(findSecret("password: <your password>"), "");
  assert.strictEqual(findSecret("The password is in 1Password."), "");
});

test("tool arguments are checked against the schema before anything runs", async () => {
  const home = scratch();
  memory.save(home, { name: "foo", title: "Foo", body: "keep me" });
  const c = connect(process.execPath, [MEMORY], { env: { JMCP_HOME: path.join(home, ".jmcp") } });
  try {
    await c.initialize("test");
    const r = await c.callTool("memory_delete", { name: ["foo"] });
    assert.strictEqual(r.isError, true);
    assert.match(r.text, /Invalid arguments: name must be a string/);
    assert.strictEqual(memory.list(home).length, 1);
  } finally {
    await c.close();
  }
});

test("skills_list searches every skill and skill_save is one transaction", async () => {
  const home = scratch();
  const store = require("../servers/skills/lib/store.js");
  for (let i = 0; i < 205; i++) store.add(path.join(home), { name: "skill-" + i, description: "Thing number " + i + (i === 204 ? " about deploys" : "") + ".", body: "b" });
  const c = connect(process.execPath, [SKILLS], { env: { JMCP_HOME: path.join(home, ".jmcp") } });
  try {
    await c.initialize("test");
    assert.match((await c.callTool("skills_list", {})).text, /and 5 more\. Call skills_list with query/);
    assert.match((await c.callTool("skills_list", { query: "deploys" })).text, /^- skill-204:/);
  } finally {
    await c.close();
  }
  const a = store.save(home, { name: "same", description: "d", body: "one" });
  const b = store.save(home, { name: "same", description: "d", body: "two" });
  assert.strictEqual(a.created, true);
  assert.strictEqual(b.created, false);
  assert.strictEqual(store.get(home, "same", { byName: true }).body, "two");
});

test("importing a skill named like another skill's id imports it", () => {
  const home = scratch();
  const other = skills.add(home, { name: "other", description: "d", body: "b" });
  const src = path.join(home, "s", other.id, "SKILL.md");
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, "---\nname: " + other.id + "\ndescription: From a file.\n---\nBody.");
  const [r] = skills.importFiles(home, [src]);
  assert.strictEqual(r.ok, true, r.error);
});

test("the skill list every session loads cuts long descriptions shorter than skills_list", async () => {
  const home = scratch();
  skills.add(home, { name: "long", description: "Use when ".repeat(60) + "END", body: "Body." });
  const c = connect(process.execPath, [SKILLS], { env: { JMCP_HOME: path.join(home, ".jmcp") } });
  try {
    const init = await c.initialize("test");
    const line = init.instructions.split("Skills:")[1].trim();
    assert.ok(line.length <= "- long: ".length + 200, String(line.length));
    assert.ok(line.endsWith("..."));
    const listed = (await c.callTool("skills_list")).text;
    assert.ok(listed.length > line.length && listed.length <= "- long: ".length + 400);
  } finally {
    await c.close();
  }
});
