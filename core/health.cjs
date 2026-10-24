"use strict";

const notes = require("../servers/health/lib/notes.js");
const quick = require("../servers/health/lib/quick.js");
const { collect } = require("../servers/health/lib/collect.js");
const { analyze, summary } = require("../servers/health/lib/analyze.js");

// The full check of one target: every problem the collector finds, worst first.
async function fullCheck(target) {
  const f = await collect(target);
  return { target: f.target, summary: summary(f), problems: analyze(f), checkedAt: Date.now() };
}

module.exports = { notes, quick, fullCheck };
