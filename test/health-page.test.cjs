"use strict";

// Health page backends: agent notes (store and show_user), ~/.ssh inventory
// and key checks, the quick host parser, and this computer's numbers.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { notes, quick } = require("../core/health.cjs");
const { connect } = require("../core/mcp-client.cjs");

const SERVER = path.join(__dirname, "..", "servers", "health", "server.cjs");
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "jmcp-hp-"));

test("notes: add, list, dismiss, bring back, dismiss all, delete", () => {
  const home = scratch();
  assert.deepStrictEqual(notes.list(home), []);
  assert.throws(() => notes.add(home, { title: " " }), /title must not be empty/);
  assert.throws(() => notes.add(home, { title: "x", level: "loud" }), /level must be one of/);
  const a = notes.add(home, { title: "Disk almost full", body: "/ is 96% full.", level: "problem", about: "ovh-backend", author: "claude-code" });
  const b = notes.add(home, { title: "Backup finished", author: "codex" });
  assert.strictEqual(b.level, "info");
  assert.deepStrictEqual(notes.list(home).map((n) => n.title), ["Backup finished", "Disk almost full"]);
  notes.dismiss(home, a.id);
  assert.deepStrictEqual(notes.list(home).map((n) => n.id), [b.id]);
  assert.strictEqual(notes.list(home, { dismissed: true }).length, 2);
  notes.dismiss(home, a.id, true);
  assert.strictEqual(notes.list(home).length, 2);
  assert.strictEqual(notes.dismissAll(home), 2);
  assert.deepStrictEqual(notes.list(home), []);
  notes.remove(home, a.id);
  assert.deepStrictEqual(notes.list(home, { dismissed: true }).map((n) => n.id), [b.id]);
  assert.throws(() => notes.remove(home, "nope"), /No note/);
});

test("show_user over MCP records the calling agent", async () => {
  const home = scratch();
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: path.join(home, ".jmcp") } });
  try {
    await c.initialize("test-agent");
    const r = await c.request("tools/call", { name: "show_user", arguments: { title: "Look at this", body: "Details.", level: "warning", about: "this computer" } });
    assert.strictEqual(r.isError, false, JSON.stringify(r));
    const bad = await c.request("tools/call", { name: "show_user", arguments: { title: "" } });
    assert.strictEqual(bad.isError, true);
  } finally {
    c.close();
  }
  const [n] = notes.list(home);
  assert.strictEqual(n.title, "Look at this");
  assert.strictEqual(n.level, "warning");
  assert.strictEqual(n.about, "this computer");
  assert.ok(n.author.length > 0);
});

test("ssh inventory: hosts, IdentityFile, Host * defaults and key details", async (t) => {
  const home = scratch();
  const dir = path.join(home, ".ssh");
  fs.mkdirSync(dir);
  try {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test key", "-f", path.join(dir, "web_key")], { windowsHide: true, stdio: "ignore" });
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "secret", "-f", path.join(dir, "spare")], { windowsHide: true, stdio: "ignore" });
  } catch {
    return t.skip("ssh-keygen is not installed");
  }
  fs.writeFileSync(path.join(dir, "config"), [
    "# Web box",
    "Host web",
    "  HostName 10.0.0.2",
    "  User me",
    "  Port 2222",
    "  IdentityFile ~/.ssh/web_key",
    "",
    "Host inner",
    "  HostName 10.0.0.3",
    "  ProxyJump web",
    "",
    "Host *.lan",
    "  User x",
    "",
    "Host *",
    "  IdentityFile ~/.ssh/gone_key",
    "",
  ].join("\n"));
  const inv = await quick.sshInventory(home);
  assert.deepStrictEqual(inv.hosts.map((x) => [x.name, x.hostname, x.user, x.port, x.via, x.note]), [["web", "10.0.0.2", "me", "2222", "", "Web box"], ["inner", "10.0.0.3", "", "", "web", ""]]);
  assert.strictEqual(path.basename(inv.hosts[1].identityFiles[0]), "gone_key");
  const by = Object.fromEntries(inv.keys.map((k) => [k.name, k]));
  assert.deepStrictEqual(Object.keys(by).sort(), ["gone_key", "spare", "web_key"]);
  assert.strictEqual(by.web_key.type, "Ed25519");
  assert.strictEqual(by.web_key.passphrase, false);
  assert.strictEqual(by.web_key.comment, "test key");
  assert.match(by.web_key.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  const keygen = execFileSync("ssh-keygen", ["-lf", path.join(dir, "web_key.pub")], { windowsHide: true, encoding: "utf8" });
  assert.ok(keygen.includes(by.web_key.fingerprint), "fingerprint matches ssh-keygen");
  assert.deepStrictEqual(by.web_key.usedBy, ["web"]);
  assert.strictEqual(by.spare.passphrase, true);
  assert.ok(by.spare.problems.some((p) => /No host/.test(p.text)));
  assert.strictEqual(by.gone_key.exists, false);
  assert.deepStrictEqual(by.gone_key.usedBy, ["inner"]);
});

test("host check output is parsed and judged", () => {
  const out = [
    "os=Ubuntu 24.04.5 LTS", "kernel=6.8.0", "host=web", "up=90061.5", "load=3.50 2.00 1.00", "cpus=2",
    "stat1=cpu  100 0 100 800 0 0 0 0 0 0", "stat2=cpu  160 0 140 900 0 0 0 0 0 0",
    "mem=2000000 100000 1000000 400000",
    "disk=20000000 500000 /", "disk=500000 400000 /boot/efi",
    "failed=nginx.service ", "reboot=yes", "docker=3 1",
  ].join("\n");
  const r = quick.parseHost(out);
  assert.strictEqual(r.cpuPct, 50);
  assert.strictEqual(r.loadPct, 175);
  assert.strictEqual(r.memory.usedPct, 95);
  assert.strictEqual(r.swap.usedPct, 60);
  assert.deepStrictEqual(r.disks.map((d) => [d.mount, d.usedPct]), [["/", 98]]);
  assert.deepStrictEqual(r.failed, ["nginx.service"]);
  assert.deepStrictEqual(r.containers, { running: 3, stopped: 1 });
  const p = quick.hostProblems(r).map((x) => x.level + ": " + x.text);
  for (const want of [/problem: \/ is 98% full/, /problem: Memory is 95%/, /warning: Swap/, /problem: Load is 3.5/, /problem: 1 failed service: nginx/, /warning: Updates are waiting/]) {
    assert.ok(p.some((x) => want.test(x)), "missing " + want + " in " + p.join(" | "));
  }
});

test("this computer: CPU, memory and disks", async () => {
  const r = await quick.localNow({ processes: false });
  assert.ok(r.cpuPct >= 0 && r.cpuPct <= 100);
  assert.ok(r.memory.totalMB > 0 && r.memory.usedPct > 0);
  assert.ok(r.disks.length >= 1);
  assert.ok(r.cpu.threads >= 1);
});

test("waiting updates are parsed and the update script is safe", () => {
  const r = quick.parseHost(["os=Ubuntu", "cpus=2", "root=sudo", "pm=apt", "upd=3", "sec=1", "pkgs=tmux openssl curl ", "listed=1700000000"].join("\n"));
  assert.deepStrictEqual(r.updates, { manager: "apt", count: 3, security: 1, packages: ["tmux", "openssl", "curl"], listedAt: 1700000000000, canApply: true });
  assert.ok(quick.hostProblems(r).some((p) => /1 security update is waiting/.test(p.text)));
  assert.strictEqual(quick.parseHost("os=x\nroot=no\npm=apt\nupd=2\n").updates.canApply, false);
  const real = quick.updateScript(false);
  assert.match(real, /--force-confold \$M <\/dev\/null/);
  assert.match(real, /pveversion/);
  assert.match(real, /M='upgrade --with-new-pkgs'/);
  assert.match(real, /apt-get -y -q \$P /);
  assert.match(real, /Always-Include-Phased-Updates=true/);
  assert.doesNotMatch(real, /(^|\s)(reboot|shutdown)(\s|$)|autoremove|purge/m);
  const sim = quick.updateScript(true);
  assert.match(sim, /apt-get -s -q \$P \$M/);
  assert.doesNotMatch(sim, /apt-get update|apt-get -y/);
});
