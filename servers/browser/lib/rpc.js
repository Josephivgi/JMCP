"use strict";

// Line-delimited JSON-RPC 2.0 over stdin/stdout for a JMCP MCP server.
// Every server keeps its own copy of this file, because each one is copied
// into ~/.jmcp/servers on its own. Keep the copies identical.
//
// methods maps a method name to a function of params that returns the result
// (or a promise of it). Throw rpcError() for protocol errors such as an
// unknown tool; any other throw becomes an internal error (-32603).
// Notifications (no id) run their method if there is one and never get a
// reply. A batch gets one array reply.

function rpcError(code, message) {
  const e = new Error(message);
  e.rpcCode = code;
  return e;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const typeOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : Number.isInteger(v) ? "integer" : typeof v);

// The first way args break a tool's inputSchema, or "" when they fit. Covers
// what JMCP schemas use: required, property types, enums, string items and
// additionalProperties: false. Wrong types must never be coerced into a
// different, valid looking value (a ["name"] array read as "name").
function checkArgs(schema, args) {
  if (!schema || schema.type !== "object") return "";
  if (args === undefined || args === null) args = {};
  if (!isObject(args)) return "arguments must be an object.";
  const props = schema.properties || {};
  for (const key of schema.required || []) if (args[key] === undefined) return key + " is required.";
  for (const [key, value] of Object.entries(args)) {
    const p = props[key];
    if (!p) {
      if (schema.additionalProperties === false) return "unknown argument " + key + ".";
      continue;
    }
    if (value === undefined) continue;
    const t = typeOf(value);
    const want = p.type;
    const fits = !want || want === t || (want === "number" && t === "integer") || (want === "integer" && t === "integer");
    if (!fits) return key + " must be " + (want === "array" ? "an array" : want === "object" || want === "integer" ? "an " + want : "a " + want) + ".";
    if (p.enum && !p.enum.includes(value)) return key + " must be one of " + p.enum.join(", ") + ".";
    if (want === "array" && p.items && p.items.type === "string" && !value.every((x) => typeof x === "string")) return key + " must be a list of strings.";
  }
  return "";
}
const goodId = (id) => typeof id === "string" || (typeof id === "number" && Number.isFinite(id));

async function respond(msg, methods) {
  if (!isObject(msg)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } };
  // A reply from the client to something we never sent: nothing to do.
  if (msg.method === undefined && ("result" in msg || "error" in msg)) return null;
  // A notification has a method and no id; an object with neither is an
  // invalid request and gets an error.
  const notification = !("id" in msg) && typeof msg.method === "string";
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || (!notification && !goodId(msg.id))) {
    return notification ? null : { jsonrpc: "2.0", id: goodId(msg.id) ? msg.id : null, error: { code: -32600, message: "Invalid request." } };
  }
  const fn = Object.hasOwn(methods, msg.method) ? methods[msg.method] : null;
  if (notification) {
    if (fn) {
      try {
        await fn(isObject(msg.params) ? msg.params : {});
      } catch {
        /* notifications have no reply */
      }
    }
    return null;
  }
  if (!fn) return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } };
  if (msg.params !== undefined && !isObject(msg.params)) return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "params must be an object." } };
  try {
    return { jsonrpc: "2.0", id: msg.id, result: await fn(msg.params || {}) };
  } catch (e) {
    return { jsonrpc: "2.0", id: msg.id, error: { code: e && e.rpcCode ? e.rpcCode : -32603, message: String((e && e.message) || e) } };
  }
}

async function handleLine(line, methods) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } };
  }
  if (!Array.isArray(msg)) return respond(msg, methods);
  if (!msg.length) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request: empty batch." } };
  const replies = (await Promise.all(msg.map((m) => respond(m, methods)))).filter(Boolean);
  return replies.length ? replies : null;
}

// Read stdin until it closes. Lines are handled as they arrive, so a slow
// tool call does not hold up a ping. onEnd runs once when stdin closes. A
// client that goes away closes stdout too: replies after that are dropped,
// and the write error ends the server through onEnd instead of crashing it
// before its cleanup is done.
function serve(methods, onEnd) {
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    if (onEnd) onEnd();
  };
  let closed = false;
  process.stdout.on("error", () => {
    closed = true;
    end();
  });
  const write = (reply) => {
    if (reply && !closed) process.stdout.write(JSON.stringify(reply) + "\n");
  };
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) handleLine(line, methods).then(write, () => {});
    }
  });
  process.stdin.on("end", end);
}

module.exports = { rpcError, respond, handleLine, serve, checkArgs };
