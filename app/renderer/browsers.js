"use strict";

// Browsers page: the headless browsers agents have open through jmcp-browser,
// with a live view of each. Loaded after app.js and uses its helpers (h,
// head, icon, render, ago, api, page, serverStrip, focusLater, go).
//
// The views refresh by swapping each <img> source in place, so the page is
// only rebuilt when a browser opens, closes, changes page or changes hands.
// Taking control turns a view into the page itself: clicks, keys, pasting
// and scrolling on the picture go to the browser until it is handed back.

const br = {
  list: null, error: "", sig: "",
  shots: new Map(), // id -> {src, width, height}
  shotErr: new Map(), // id -> message
  notes: new Map(), // id -> note for the agent, typed while in control
  notified: new Set(), // ids whose "needs you" notice was shown
  big: "", ask: "", busy: "", closeErr: "", controlErr: "",
  shooting: false, looping: false, kick: null,
  queue: Promise.resolve(),
};

function openBrowsers() {
  return br.list ? br.list.open.length : 0;
}

function browsersAsking() {
  return br.list ? br.list.open.filter((b) => b.control === "asked").length : 0;
}

// What the page shows apart from the images; a change means a re-render.
function browserSig(l) {
  return JSON.stringify([l.open.map((b) => [b.id, b.title, b.url, b.lastAction, b.control, b.askReason]), l.recent.map((b) => b.id)]);
}

// A desktop notice when an agent asks for the user, once per request.
function noticeAsks(l) {
  for (const b of l.open) {
    const key = b.id + "/" + b.askAt;
    if (b.control !== "asked" || br.notified.has(key)) continue;
    br.notified.add(key);
    try {
      const n = new Notification(b.agent + " needs you in its browser", { body: b.askReason || "Open JMCP to take control." });
      n.onclick = () => {
        window.focus();
        go("browsers");
      };
    } catch {
      /* notices are a convenience */
    }
  }
}

async function loadBrowsers() {
  try {
    const l = await api.browser.list();
    br.list = l;
    br.error = "";
    for (const id of [...br.shots.keys()]) if (!l.open.some((b) => b.id === id)) br.shots.delete(id);
    noticeAsks(l);
    const sig = browserSig(l);
    const changed = sig !== br.sig;
    br.sig = sig;
    return changed;
  } catch (e) {
    const changed = br.error !== e.message;
    br.error = e.message;
    return changed;
  }
}

function showShot(id) {
  const shot = br.shots.get(id);
  for (const img of document.querySelectorAll("img[data-shot]")) {
    if (img.dataset.shot !== id || !shot || img.src === shot.src) continue;
    img.src = shot.src;
    const box = img.closest(".br-view, .br-live");
    if (box) box.classList.remove("waiting");
  }
  for (const note of document.querySelectorAll("[data-shot-err]")) if (note.dataset.shotErr === id) note.textContent = br.shotErr.get(id) || "";
}

async function takeShot(id) {
  try {
    br.shots.set(id, await api.browser.shot(id));
    br.shotErr.delete(id);
  } catch (e) {
    br.shotErr.set(id, e.message);
  }
  showShot(id);
}

// One screenshot per open browser, set on its <img> directly.
async function refreshShots() {
  if (br.shooting || !br.list) return;
  br.shooting = true;
  try {
    for (const b of br.list.open) if (b.control !== "user") await takeShot(b.id);
  } finally {
    br.shooting = false;
  }
}

// The browser in the user's hands refreshes several times a second, and at
// once after each input.
async function controlLoop() {
  if (br.looping) return;
  br.looping = true;
  try {
    while (page === "browsers" && !document.hidden && br.list) {
      const b = br.list.open.find((x) => x.control === "user");
      if (!b) break;
      await takeShot(b.id);
      await new Promise((r) => {
        br.kick = r;
        setTimeout(r, 400);
      });
      br.kick = null;
    }
  } finally {
    br.looping = false;
  }
}

setInterval(async () => {
  if (document.hidden || !st) return;
  const changed = await loadBrowsers();
  if (changed && !br.busy) render();
  if (page === "browsers") {
    refreshShots();
    controlLoop();
  }
}, 2000);
setTimeout(() => loadBrowsers().then((changed) => changed && st && render()), 400);

async function browserAct(id, work, errKey) {
  br.busy = id;
  br[errKey] = "";
  render();
  try {
    await work();
  } catch (e) {
    br[errKey] = e.message;
  }
  br.busy = "";
  await loadBrowsers();
  render();
  controlLoop();
}

const closeBrowser = (id) => browserAct(id, async () => {
  await api.browser.close(id);
  br.ask = "";
  if (br.big === id) br.big = "";
}, "closeErr");

const takeControl = (id) => browserAct(id, async () => {
  await api.browser.control(id);
  focusLater("br-live-" + id);
}, "controlErr");

const handBack = (id) => browserAct(id, async () => {
  await api.browser.handBack(id, br.notes.get(id) || "");
  br.notes.delete(id);
}, "controlErr");

// ---- Control: input on the picture goes to the page ----

const KEY_NAMES = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
const MOUSE = ["left", "middle", "right"];

function sendInput(id, ev) {
  br.queue = br.queue
    .then(() => api.browser.input(id, ev))
    .then(() => {
      if (br.controlErr) {
        br.controlErr = "";
        render();
      }
    })
    .catch((e) => {
      br.controlErr = e.message;
      render();
    })
    .then(() => br.kick && br.kick());
}

function liveView(b) {
  const shot = br.shots.get(b.id);
  const img = h("img", { "data-shot": b.id, alt: "The page in " + b.name + ". Click, type and scroll here.", draggable: "false" });
  if (shot) img.src = shot.src;
  const at = (e) => {
    const s = br.shots.get(b.id) || { width: 1280, height: 800 };
    const r = img.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * s.width), y: Math.round(((e.clientY - r.top) / r.height) * s.height) };
  };
  let pressed = "";
  let lastMove = 0;
  const box = h("div", { class: "br-live" + (shot ? "" : " waiting"), tabindex: "0", role: "application", "aria-label": "Live page of " + b.name + ". Keys and clicks go to the page.", "data-focus-key": "br-live-" + b.id }, img, h("span", { class: "br-wait", text: "Loading view…" }));
  img.addEventListener("mousedown", (e) => {
    e.preventDefault();
    box.focus();
    pressed = MOUSE[e.button] || "left";
    sendInput(b.id, Object.assign({ type: "move", pressed: false }, at(e)));
    sendInput(b.id, Object.assign({ type: "down", button: pressed }, at(e)));
  });
  img.addEventListener("mousemove", (e) => {
    if (!pressed || Date.now() - lastMove < 50) return;
    lastMove = Date.now();
    sendInput(b.id, Object.assign({ type: "move", pressed: true, button: pressed }, at(e)));
  });
  const up = (e) => {
    if (!pressed) return;
    sendInput(b.id, Object.assign({ type: "up", button: pressed }, at(e)));
    pressed = "";
  };
  img.addEventListener("mouseup", up);
  img.addEventListener("mouseleave", up);
  img.addEventListener("contextmenu", (e) => e.preventDefault());
  img.addEventListener("wheel", (e) => {
    e.preventDefault();
    sendInput(b.id, Object.assign({ type: "wheel", dx: e.deltaX, dy: e.deltaY }, at(e)));
  }, { passive: false });
  box.addEventListener("keydown", (e) => {
    // Ctrl+V comes through as a paste event.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
    if (KEY_NAMES.has(e.key)) {
      e.preventDefault();
      sendInput(b.id, { type: "key", key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey });
    } else if (e.key === " " || (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      e.preventDefault();
      sendInput(b.id, { type: "text", text: e.key });
    }
  });
  box.addEventListener("paste", (e) => {
    const text = e.clipboardData ? e.clipboardData.getData("text") : "";
    e.preventDefault();
    if (text) sendInput(b.id, { type: "text", text });
  });
  return box;
}

function programName(p) {
  return /msedge/i.test(p) ? "Edge" : /chrom/i.test(p) ? "Chrome" : "Browser";
}

function controlPanel(b) {
  const busy = br.busy === b.id;
  if (b.control === "user") {
    return h("div", { class: "ok-box br-control", role: "status" },
      h("span", { class: "box-title", text: "You are in control" }),
      h("span", { text: (b.askReason ? b.agent + " asked: " + b.askReason + ". " : "") + "Click the page, then type; keys go to the page while it has focus. Paste with Ctrl+V. The agent waits until you hand it back." }),
      h("input", { class: "lib-input", "aria-label": "Note for the agent", placeholder: "Note for the agent (optional), e.g. Logged in, go on", value: br.notes.get(b.id) || "", "data-focus-key": "br-note-" + b.id, oninput: (e) => br.notes.set(b.id, e.target.value), onkeydown: (e) => e.key === "Enter" && handBack(b.id) }),
      h("div", { class: "row-actions" },
        h("button", { class: "btn small primary", disabled: busy, "data-focus-key": "br-back-" + b.id, onclick: () => handBack(b.id) }, busy ? "Handing back…" : "Hand back to agent"),
      ),
      br.controlErr ? h("span", { class: "bad", text: br.controlErr }) : null,
    );
  }
  if (b.control === "asked") {
    return h("div", { class: "warn-box br-control", role: "alert" },
      h("span", { class: "box-title", text: b.agent + " needs you" }),
      h("span", { text: b.askReason }),
      h("div", { class: "row-actions" },
        h("button", { class: "btn small primary", disabled: busy, "data-focus-key": "br-take-" + b.id, onclick: () => takeControl(b.id) }, busy ? "Taking control…" : "Take control"),
      ),
      br.controlErr ? h("span", { class: "bad", text: br.controlErr }) : null,
    );
  }
  return null;
}

function browserCard(b) {
  const controlling = b.control === "user";
  const big = br.big === b.id || controlling;
  const shot = br.shots.get(b.id);
  const img = h("img", { "data-shot": b.id, alt: "Live view of " + (b.title || b.url || b.name) });
  if (shot) img.src = shot.src;
  const asking = br.ask === b.id;
  return h("article", { class: "panel br-card" + (big ? " big" : "") + (b.control === "asked" ? " asking" : "") + (controlling ? " controlling" : "") },
    // In control, Hand back stays above the page so it never scrolls away.
    controlling ? h("div", { class: "br-top" }, controlPanel(b)) : null,
    controlling ? liveView(b) : h("div", { class: "br-view" + (shot ? "" : " waiting") }, img, h("span", { class: "br-wait", text: "Loading view…" })),
    h("div", { class: "br-body" },
      h("div", { class: "br-title-row" },
        h("span", { class: "dot" }),
        h("span", { class: "br-title", title: b.title, text: b.title || "(no title)" }),
        b.control === "asked" ? h("span", { class: "pill warn", text: "Needs you" }) : controlling ? h("span", { class: "pill ok", text: "You have control" }) : null,
      ),
      h("div", { class: "br-url mono", title: b.url, text: b.url || "about:blank" }),
      h("div", { class: "br-meta" },
        h("span", { class: "tag", text: b.agent }),
        h("span", { text: b.name + " · " + programName(b.program) + " · opened " + ago(b.startedAt) }),
      ),
      b.cwd ? h("div", { class: "br-cwd mono", title: b.cwd, text: b.cwd }) : null,
      b.lastAction ? h("div", { class: "br-last" }, h("span", { class: "br-last-label", text: "Last action" }), h("span", { text: b.lastAction + " · " + ago(b.updatedAt) })) : null,
      h("div", { class: "br-shot-err hint", "data-shot-err": b.id, text: br.shotErr.get(b.id) || "" }),
      controlling ? null : controlPanel(b),
      asking
        ? h("div", { class: "warn-box br-ask", role: "alert" },
            h("span", { text: "Close this browser? The agent loses the page it is on and gets told it was closed." }),
            h("div", { class: "row-actions" },
              h("button", { class: "btn small danger", disabled: br.busy === b.id, "data-focus-key": "br-yes-" + b.id, onclick: () => closeBrowser(b.id) }, br.busy === b.id ? "Closing…" : "Close browser"),
              h("button", { class: "btn small quiet", disabled: br.busy === b.id, onclick: () => ((br.ask = ""), render()) }, "Cancel"),
            ),
            br.closeErr ? h("span", { class: "bad", text: br.closeErr }) : null,
          )
        : h("div", { class: "row-actions" },
            controlling ? null : h("button", { class: "btn small", "data-focus-key": "br-big-" + b.id, onclick: () => ((br.big = big ? "" : b.id), render()) }, big ? "Smaller view" : "Larger view"),
            b.control ? null : h("button", { class: "btn small", disabled: br.busy === b.id, "data-focus-key": "br-take-" + b.id, onclick: () => takeControl(b.id), title: "Drive this browser yourself. The agent waits until you hand it back." }, "Take control"),
            h("button", { class: "btn small quiet danger", "data-focus-key": "br-close-" + b.id, onclick: () => { br.ask = b.id; br.closeErr = ""; render(); focusLater("br-yes-" + b.id); } }, "Close"),
          ),
    ),
  );
}

function recentList(list) {
  if (!list.length) return null;
  return h("section", { class: "hl-section" },
    h("div", { class: "hl-section-head" }, h("h2", { text: "Recently closed" })),
    h("div", { class: "panel br-recent" },
      list.map((b) => h("div", { class: "br-recent-row" },
        h("span", { class: "tag", text: b.agent }),
        h("span", { class: "br-recent-page", title: b.url, text: (b.title || b.url || "about:blank") }),
        h("span", { class: "hint", text: b.closedReason }),
        h("span", { class: "when", text: ago(b.closedAt) }),
      )),
    ),
  );
}

function browsersPage() {
  if (!br.list && !br.error) loadBrowsers().then(() => (render(), refreshShots(), controlLoop()));
  const l = br.list;
  // Browsers that need the user come first.
  const order = (b) => (b.control === "user" ? 0 : b.control === "asked" ? 1 : 2);
  return h("div", { class: "page br-page" },
    head("Browsers", "The browsers your agents have open through jmcp-browser. They run hidden; the view here updates every 2 seconds. Take control of one to click and type in it yourself, for example to solve a CAPTCHA, then hand it back."),
    serverStrip("browser", "Agents open one with browser_open, and call browser_handoff when they need you. A running agent gets the server in its next session."),
    br.error ? h("div", { class: "error-box", role: "alert", text: br.error }) : null,
    !l ? h("div", { class: "panel empty", text: "Loading browsers…" })
      : l.open.length ? h("div", { class: "br-grid" }, [...l.open].sort((a, b) => order(a) - order(b)).map(browserCard))
      : h("div", { class: "panel hl-empty" },
          h("p", { class: "hl-empty-title", text: "No browsers open" }),
          h("p", { class: "hint", text: "When an agent opens a browser with jmcp-browser, it shows here with a live view of the page. It closes when the agent is done or its session ends." }),
        ),
    l ? recentList(l.recent) : null,
  );
}
