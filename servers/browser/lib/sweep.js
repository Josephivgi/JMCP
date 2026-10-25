"use strict";

// Browsers left open by a server that died without cleaning up (its agent
// was killed). The server runs this when it starts and the app when it lists
// browsers. A browser is only closed after its DevTools port proves it is the
// same browser the row started, so a reused pid or port is never touched.

const cdp = require("./cdp.js");
const store = require("./store.js");

// Quit one browser by its row, from outside the server that started it.
async function closeRow(home, row, reason) {
  if (await cdp.sameBrowser(row.port, row.browser_ws)) {
    await cdp.closeBrowser(row.browser_ws);
    const until = Date.now() + 3000;
    while (Date.now() < until && store.alive(row.browser_pid)) await cdp.sleep(100);
    if (store.alive(row.browser_pid) && (await cdp.sameBrowser(row.port, row.browser_ws))) await cdp.killPid(row.browser_pid);
  }
  store.close(home, row.id, reason);
  await cdp.removeProfile(row.profile);
}

async function sweep(home) {
  const closed = [];
  for (const row of store.open(home)) {
    if (row.server_pid === process.pid) continue;
    // A live server owns its browser; only a browser process that is gone
    // is marked closed for it.
    if (store.alive(row.server_pid)) {
      if (store.alive(row.browser_pid)) continue;
      store.close(home, row.id, "The browser quit.");
      await cdp.removeProfile(row.profile);
      closed.push(row.id);
      continue;
    }
    await closeRow(home, row, "The agent's session ended.");
    closed.push(row.id);
  }
  return closed;
}

module.exports = { sweep, closeRow };
