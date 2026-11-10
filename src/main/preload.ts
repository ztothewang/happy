import { contextBridge, ipcRenderer, webUtils } from "electron";
import { makeApi } from "../shared/api.js";

function listen<T>(channel: string, cb: (v: T) => void) {
  const h = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => {
    ipcRenderer.removeListener(channel, h);
  };
}

contextBridge.exposeInMainWorld(
  "hub",
  makeApi((channel, ...args) => ipcRenderer.invoke(channel, ...args), listen, { pathForFile: (file) => webUtils.getPathForFile(file) }),
);
