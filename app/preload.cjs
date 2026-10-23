"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const call = async (name, ...args) => {
  const r = await ipcRenderer.invoke(name, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld("jmcp", {
  state: () => call("state"),
  install: (id, agentIds) => call("install", id, agentIds),
  uninstall: (id, agentIds) => call("uninstall", id, agentIds),
  update: (id) => call("update", id),
  startupUpdates: () => call("startup-updates"),
  probe: (agentId, name) => call("probe", agentId, name),
  activity: () => call("activity"),
  reveal: (file) => call("reveal", file),
});
