"use strict";

// JMCP app updates from GitHub Releases, driven with a fake electron-updater:
// nothing downloads until Update, progress and errors reach the window, and
// running from source never touches the updater.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createUpdater, friendly } = require("../app/updater.cjs");

function fake(script) {
  const u = new EventEmitter();
  u.calls = [];
  u.checkForUpdates = async () => {
    u.calls.push("check");
    return script.check(u);
  };
  u.downloadUpdate = async () => {
    u.calls.push("download");
    return script.download(u);
  };
  u.quitAndInstall = (silent, run) => u.calls.push("install:" + silent + ":" + run);
  return u;
}

function make(script, packaged = true) {
  const seen = [];
  const updater = fake(script);
  const up = createUpdater({ updater, packaged, version: "0.1.0", onChange: (s) => seen.push(s.status) });
  return { up, updater, seen };
}

test("a new release is offered, downloaded only on Update, then installed", async () => {
  const { up, updater, seen } = make({
    check: (u) => {
      u.emit("checking-for-update");
      u.emit("update-available", { version: "0.2.0" });
      return { isUpdateAvailable: true, updateInfo: { version: "0.2.0" } };
    },
    download: (u) => {
      u.emit("download-progress", { percent: 41.6 });
      assert.strictEqual(up.state().percent, 42);
      u.emit("update-downloaded", { version: "0.2.0" });
    },
  });
  assert.strictEqual(updater.autoDownload, false);
  assert.strictEqual(updater.autoInstallOnAppQuit, true);
  assert.strictEqual(up.state().status, "idle");
  await up.check();
  assert.deepStrictEqual(updater.calls, ["check"]);
  assert.strictEqual(up.state().status, "available");
  assert.strictEqual(up.state().latest, "0.2.0");
  assert.throws(() => up.install(), /not finished/);
  await up.download();
  assert.strictEqual(up.state().status, "ready");
  up.install();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(updater.calls, ["check", "download", "install:true:true"]);
  assert.deepStrictEqual(seen, ["checking", "checking", "available", "downloading", "downloading", "ready"]);
});

test("no new release says up to date and Update is refused", async () => {
  const { up } = make({
    check: (u) => {
      u.emit("update-not-available", { version: "0.1.0" });
      return { isUpdateAvailable: false, updateInfo: { version: "0.1.0" } };
    },
  });
  await up.check();
  assert.strictEqual(up.state().status, "current");
  await assert.rejects(up.download(), /no new version/);
});

test("a check that ends without events still settles", async () => {
  const { up } = make({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.0" } }) });
  await up.check();
  assert.strictEqual(up.state().status, "available");
  assert.strictEqual(up.state().latest, "1.0.0");
});

test("errors become plain messages and Try again can check again", async () => {
  let fail = true;
  const { up, updater } = make({
    check: () => {
      if (fail) throw new Error("getaddrinfo ENOTFOUND api.github.com");
      return { isUpdateAvailable: false };
    },
  });
  await up.check();
  assert.strictEqual(up.state().status, "error");
  assert.match(up.state().error, /Could not reach GitHub/);
  fail = false;
  await up.check();
  assert.strictEqual(up.state().status, "current");
  assert.strictEqual(up.state().error, "");
  assert.deepStrictEqual(updater.calls, ["check", "check"]);
});

test("a failed download shows the error", async () => {
  const { up } = make({
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "0.2.0" } }),
    download: () => {
      throw new Error("sha512 checksum mismatch, expected abc");
    },
  });
  await up.check();
  await up.download();
  assert.strictEqual(up.state().status, "error");
  assert.match(up.state().error, /did not match/);
});

test("running from source never calls the updater", async () => {
  const { up, updater } = make({ check: () => assert.fail("checked") }, false);
  assert.strictEqual(up.state().status, "source");
  await up.check();
  assert.deepStrictEqual(updater.calls, []);
  await assert.rejects(up.download(), /running from source/);
  assert.strictEqual(updater.autoDownload, undefined);
});

test("friendly keeps the first line of other errors", () => {
  assert.match(friendly(new Error("HttpError: 404 \n latest.yml not found")), /No JMCP release/);
  assert.strictEqual(friendly(new Error("Something odd\nstack")), "Something odd");
});

test("the release config publishes to the public JMCP repo", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.deepStrictEqual(pkg.build.publish[0], { provider: "github", owner: "Josephivgi", repo: "JMCP", releaseType: "release" });
  // Servers are copied out of the app folder, so they must stay plain files.
  assert.strictEqual(pkg.build.asar, false);
  assert.ok(pkg.build.files.includes("servers/**"));
  const wf = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "release.yml"), "utf8");
  assert.match(wf, /tags:\s*\["v\*"\]/);
  assert.match(wf, /servers\/subagents/);
});
