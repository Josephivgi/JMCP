const fs = require("fs");
const path = require("path");

function resolveSafe(cwd, filePath) {
  const raw = String(filePath || "");
  if (!raw) throw new Error("path is required");
  const resolved = path.resolve(cwd || process.cwd(), raw);
  return resolved;
}

// Agents read a whole file before they edit it, so this stays large enough
// for big files. The agent itself decides how much of a read reaches its
// context.
const READ_MAX = 4 * 1024 * 1024;
const WRITE_MAX = 4 * 1024 * 1024;

// Async with a size cap: a sync read of a FIFO or a huge file would block
// the whole main process behind one agent request.
async function readTextFile(params, cwd) {
  const file = resolveSafe(cwd, params && params.path);
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw new Error("not a regular file");
  const line = params && typeof params.line === "number" && params.line >= 0 ? Math.floor(params.line) : null;
  const limit = params && typeof params.limit === "number" && params.limit >= 0 ? Math.floor(params.limit) : null;
  if (line == null && limit == null) {
    if (stat.size > READ_MAX) throw new Error("file is too large to read whole (" + Math.round(stat.size / 1024) + " KB); read it in parts with line and limit");
    return { content: await fs.promises.readFile(file, "utf8") };
  }
  // ACP counts lines 1-based; return [line, line + limit). A paged read of a
  // big file streams and stops at the last wanted line, and the reply stays
  // under READ_MAX however long the lines are.
  const start = line == null ? 0 : Math.max(0, line - 1);
  const end = limit == null ? Infinity : start + limit;
  return { content: await readLines(file, start, end) };
}

function readLines(file, start, end) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { encoding: "utf8" });
    const out = [];
    let size = 0;
    let n = 0;
    let rest = "";
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      stream.destroy();
      if (err) reject(err);
      else resolve(out.join("\n"));
    };
    const take = (text) => {
      if (n >= start && n < end) {
        size += Buffer.byteLength(text, "utf8") + 1;
        if (size > READ_MAX) return finish(new Error("the requested lines are too large to read; ask for fewer"));
        out.push(text);
      }
      n++;
      if (n >= end) finish();
    };
    stream.on("data", (chunk) => {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop();
      // A single line longer than READ_MAX cannot fit in any reply.
      if (rest.length > READ_MAX && n >= start && n < end) return finish(new Error("the requested lines are too large to read; ask for fewer"));
      if (rest.length > READ_MAX) rest = "";
      for (const p of parts) {
        take(p);
        if (done) return;
      }
    });
    stream.on("end", () => {
      take(rest);
      finish();
    });
    stream.on("error", finish);
  });
}

async function writeTextFile(params, cwd) {
  const file = resolveSafe(cwd, params && params.path);
  const content = String((params && params.content) || "");
  if (Buffer.byteLength(content, "utf8") > WRITE_MAX) throw new Error("content is too large to write");
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, content, "utf8");
  return {};
}

module.exports = { readTextFile, writeTextFile, resolveSafe };
