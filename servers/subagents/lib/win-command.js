const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function isFile(file) {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function pathDirs() {
  return (process.env.PATH || "").split(path.delimiter).filter(Boolean);
}

function resolveProgram(name) {
  const raw = String(name || "").trim().replace(/^"+|"+$/g, "");
  if (!raw) return raw;
  if (path.isAbsolute(raw) && isFile(raw) && !/\.ps1$/i.test(raw)) return raw;
  if (process.platform !== "win32") {
    if (isFile(raw)) return path.resolve(raw);
    for (const dir of pathDirs()) {
      const candidate = path.join(dir, raw);
      if (isFile(candidate)) return candidate;
    }
    return raw;
  }
  const exts = path.extname(raw) ? [""] : [".exe", ".cmd", ".bat", ".com"];
  const bases = path.isAbsolute(raw) ? [raw] : pathDirs().map((dir) => path.join(dir, raw));
  for (const base of bases) {
    for (const ext of exts) {
      const candidate = ext ? base + ext : base;
      if (isFile(candidate) && !/\.ps1$/i.test(candidate)) return candidate;
    }
  }
  return raw;
}

function npmShimEntry(text, dir) {
  const key = "node_modules";
  let from = 0;
  while (from < text.length) {
    const idx = text.indexOf(key, from);
    if (idx < 0) return null;
    const quoteAt = text.lastIndexOf('"', idx);
    if (quoteAt < 0) {
      from = idx + key.length;
      continue;
    }
    const rest = text.slice(quoteAt + 1);
    const end = rest.indexOf('"');
    if (end < 0) {
      from = idx + key.length;
      continue;
    }
    const raw = rest
      .slice(0, end)
      .replace(/%dp0%\\/gi, "")
      .replace(/%dp0%\//gi, "")
      .replace(/%~dp0/gi, "")
      .replace(/\//g, "\\");
    const trimmed = raw.replace(/^\\+/, "");
    const candidate = path.isAbsolute(trimmed) ? trimmed : path.join(dir, trimmed);
    if (isFile(candidate)) return candidate;
    from = idx + key.length;
  }
  return null;
}

function unwrapNpmCmd(cmdPath) {
  const ext = path.extname(cmdPath).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return null;
  let text = "";
  try {
    text = fs.readFileSync(cmdPath, "utf8");
  } catch {
    return null;
  }
  const dir = path.dirname(cmdPath);
  const entry = npmShimEntry(text, dir);
  if (!entry) return null;
  if (path.extname(entry).toLowerCase() === ".exe") {
    return { command: entry, args: [] };
  }
  const bundled = path.join(dir, "node.exe");
  // resolveProgram returns the name on a miss, so check the hit is real. The
  // bare name is fine either way: spawn resolves it through PATH.
  const onPath = resolveProgram("node");
  const node = isFile(bundled) ? bundled : isFile(onPath) ? onPath : "node";
  return { command: node, args: [entry] };
}

function spawnArgv(command, args) {
  const extra = Array.isArray(args) ? args.slice() : [];
  const resolved = resolveProgram(command);
  const unwrapped = unwrapNpmCmd(resolved);
  if (unwrapped) {
    return {
      command: unwrapped.command,
      args: unwrapped.args.concat(extra),
      resolved,
    };
  }
  const ext = path.extname(resolved).toLowerCase();
  if (process.platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    // Non-shim batch files: run through cmd via shell: true so Node builds
    // the command line with correct quoting for paths that contain spaces.
    // Manually composing `cmd /s /c` mangles quoted spaced paths.
    return {
      command: resolved,
      args: extra,
      resolved,
      viaCmd: true,
      shell: true,
    };
  }
  return { command: resolved, args: extra, resolved };
}

function spawnHidden(command, args, options) {
  const argv = spawnArgv(command, args);
  const startedAt = Date.now();
  const child = spawn(
    argv.command,
    argv.args,
    Object.assign(
      {
        windowsHide: true,
      },
      argv.shell ? { shell: true } : {},
      options || {},
    ),
  );
  return watch(child, startedAt);
}

// Records when a child started (startedAt: Date.now() taken just before
// spawn, so it is never later than the process's creation) and when it
// ended, so killTree can still find what it left running after it exited.
// Every child that killTree may kill goes through this.
function watch(child, startedAt) {
  child.jmcpStartedAt = startedAt;
  child.once("exit", () => {
    child.jmcpExitedAt = Date.now();
  });
  return child;
}

const exited = (child) => child.exitCode != null || child.signalCode != null;

// Resolves with the exit code (null when it could not start).
function runHidden(command, args) {
  return new Promise((resolve) => {
    const t = spawn(command, args, { windowsHide: true, stdio: "ignore" });
    t.on("error", () => resolve(null));
    t.on("close", (code) => resolve(code));
  });
}

// Windows: processes a dead parent started. Its pid may have belonged to
// other processes before it and after it, so only children created while it
// ran count. A dead middle process still hides what it started; finding those
// would need a Windows job object.
function killOrphans(pid, startedAt, exitedAt) {
  const at = (ms) => "[DateTimeOffset]::FromUnixTimeMilliseconds(" + Math.floor(ms) + ").LocalDateTime";
  const script =
    "$a = " + at(startedAt) + "; $b = " + at(exitedAt) + "; " +
    "Get-CimInstance Win32_Process -Filter 'ParentProcessId=" + Number(pid) + "' | " +
    "Where-Object { $_.CreationDate -ge $a -and $_.CreationDate -le $b } | " +
    "ForEach-Object { taskkill /pid $_.ProcessId /t /f | Out-Null }";
  return runHidden("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script]);
}

// child.kill() signals only the direct child. cmd.exe wrappers and adapters
// that spawn their own helpers (codex-acp runs codex app-server) leave a live
// grandchild holding the pipes, so kills go through the process tree, also
// after the child itself has exited. Resolves once the kill is done, so a
// caller about to exit can wait for it.
function killTree(child) {
  if (!child) return Promise.resolve();
  const pid = child.pid;
  if (pid && process.platform === "win32") {
    const orphans = () => {
      // Without both times the pid cannot be matched safely; leave it.
      if (!child.jmcpStartedAt || !child.jmcpExitedAt) return Promise.resolve();
      return killOrphans(pid, child.jmcpStartedAt, child.jmcpExitedAt);
    };
    if (exited(child)) return orphans();
    // taskkill fails when the child exits just before it looks; then what it
    // left behind is found as orphans. The exit event can lag, so wait for it.
    return runHidden("taskkill", ["/pid", String(pid), "/t", "/f"]).then((code) => {
      if (code === 0) return undefined;
      return new Promise((r) => (exited(child) ? r() : (child.once("exit", r), setTimeout(r, 1000).unref()))).then(() => (exited(child) ? orphans() : undefined));
    });
  }
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return Promise.resolve();
    } catch {
      /* not a group leader or already gone */
    }
  }
  try {
    child.kill();
  } catch {
    /* gone */
  }
  return Promise.resolve();
}

module.exports = {
  isFile,
  resolveProgram,
  unwrapNpmCmd,
  spawnArgv,
  spawnHidden,
  watch,
  killOrphans,
  killTree,
};
