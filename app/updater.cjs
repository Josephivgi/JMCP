"use strict";

// Updates for the installed JMCP app, from the GitHub Releases of
// Josephivgi/JMCP (electron-updater reads the latest.yml that the release
// workflow publishes). Nothing downloads until the user presses Update.
//
// The updater is passed in, so tests can drive it with a fake. When JMCP
// runs from source (npm start) there is no installer to update; the state
// says "source" and checks do nothing.

const RELEASES_URL = "https://github.com/Josephivgi/JMCP/releases";

// status: source | idle | checking | current | available | downloading | ready | error
function createUpdater({ updater, packaged, version, onChange }) {
  let state = { status: packaged ? "idle" : "source", version: String(version || ""), latest: "", percent: 0, error: "", checkedAt: 0 };
  const set = (patch) => {
    state = Object.assign({}, state, patch);
    if (onChange) onChange(state);
  };

  if (packaged) {
    updater.autoDownload = false;
    // A downloaded update the user did not restart for installs when JMCP quits.
    updater.autoInstallOnAppQuit = true;
    updater.on("checking-for-update", () => set({ status: "checking", error: "" }));
    updater.on("update-available", (info) => set({ status: "available", latest: String((info && info.version) || ""), checkedAt: Date.now() }));
    updater.on("update-not-available", () => set({ status: "current", latest: "", checkedAt: Date.now() }));
    updater.on("download-progress", (p) => set({ status: "downloading", percent: Math.max(0, Math.min(100, Math.round((p && p.percent) || 0))) }));
    updater.on("update-downloaded", (info) => set({ status: "ready", latest: String((info && info.version) || state.latest), percent: 100 }));
    updater.on("error", (e) => set({ status: "error", error: friendly(e) }));
  }

  const busy = () => state.status === "checking" || state.status === "downloading";

  return {
    state: () => state,
    async check() {
      if (!packaged || busy() || state.status === "ready") return state;
      set({ status: "checking", error: "" });
      try {
        const r = await updater.checkForUpdates();
        // The events normally set the result; this covers a check that ended without one.
        if (state.status === "checking") {
          const info = r && r.updateInfo;
          if (r && r.isUpdateAvailable && info) set({ status: "available", latest: String(info.version || ""), checkedAt: Date.now() });
          else set({ status: "current", latest: "", checkedAt: Date.now() });
        }
      } catch (e) {
        set({ status: "error", error: friendly(e) });
      }
      return state;
    },
    async download() {
      if (!packaged) throw new Error("JMCP is running from source. Install it from GitHub Releases to update in the app.");
      if (state.status !== "available") throw new Error("There is no new version to download.");
      set({ status: "downloading", percent: 0, error: "" });
      try {
        await updater.downloadUpdate();
        if (state.status === "downloading") set({ status: "ready", percent: 100 });
      } catch (e) {
        set({ status: "error", error: friendly(e) });
      }
      return state;
    },
    // Quit and run the new installer silently; it starts JMCP again after.
    install() {
      if (state.status !== "ready") throw new Error("The update has not finished downloading.");
      setImmediate(() => updater.quitAndInstall(true, true));
      return state;
    },
  };
}

function friendly(e) {
  const msg = String((e && e.message) || e || "");
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR_/.test(msg)) return "Could not reach GitHub. Check your internet connection and try again.";
  if (/latest\.yml|404|Unable to find latest version|No published versions/i.test(msg)) return "No JMCP release on GitHub has an update file yet.";
  if (/sha512 checksum mismatch/i.test(msg)) return "The download did not match the release. Try again.";
  const first = msg.split("\n")[0].trim();
  return first.length > 200 ? first.slice(0, 200) + "…" : first || "The update failed.";
}

module.exports = { createUpdater, friendly, RELEASES_URL };
