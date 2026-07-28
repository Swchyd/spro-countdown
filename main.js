// Desktop shell for SPro Countdown.
//
// Runs the stage server in-process and shows the app in a chromeless window,
// so the operator gets a normal Windows app instead of a console. The server
// lives and dies with the window; there is no separate thing to remember to
// start or stop.

const { app, BrowserWindow, Tray, Menu, dialog, clipboard, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const stage = require("./server.js");

const PORT = Number(process.env.PORT) || 8080;

let win = null;
let tray = null;
let server = null;

// Only one copy may hold the port; a second launch just reveals the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", reveal);
  app.whenReady().then(boot);
}

function reveal() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Put the launcher on the Desktop the first time this machine runs the app.
// Guarded by a marker rather than a file-exists check, so deleting the icon
// on purpose makes it stay deleted.
function ensureShortcuts() {
  if (process.platform !== "win32") return;
  // A portable build is extracted to a new temp folder on every run, so a
  // shortcut to it would point at nothing next time. The .exe is the icon.
  if (app.isPackaged) return;
  const marker = path.join(app.getPath("userData"), "shortcuts-created");
  if (fs.existsSync(marker)) return;

  const opts = {
    target: process.execPath,
    args: ".",
    cwd: __dirname,
    icon: path.join(__dirname, "icon.ico"),
    iconIndex: 0,
    description: "SPro Countdown - stage timer"
  };

  for (const spot of [app.getPath("desktop"), __dirname]) {
    try {
      shell.writeShortcutLink(path.join(spot, "SPro Countdown.lnk"), "create", opts);
    } catch (e) {}
  }

  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
  } catch (e) {}
}

function boot() {
  ensureShortcuts();
  stage.start({
    port: PORT,
    // Inside a packaged build the app folder is read-only, so the keys have
    // to live somewhere writable — and somewhere that survives, since the CA
    // is what the iPad trusts.
    certDir: path.join(app.getPath("userData"), "certs"),
    onReady: function (handle) {
      server = handle;
      createWindow();
      createTray();
    },
    onError: function (err) {
      dialog.showErrorBox(
        "SPro Countdown",
        err.code === "EADDRINUSE"
          ? `Port ${err.port} is already in use.\n\nAnother copy of the timer — or a ` +
            `start-timer.bat window — is probably still running. Close it, then open ` +
            `this again.`
          : `Could not start the local server.\n\n${err.message}`
      );
      app.quit();
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#0B0D12",
    title: "SPro Countdown",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "icon-180.png"),
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.once("ready-to-show", () => win.show());

  // Keep the title fixed — the page would otherwise rename the window.
  win.on("page-title-updated", (e) => e.preventDefault());

  // Anything that is not the app itself belongs in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => { win = null; });
}

function createTray() {
  tray = new Tray(path.join(__dirname, "icon-180.png"));
  tray.setToolTip("SPro Countdown");
  tray.on("click", reveal);
  refreshTrayMenu();

  // Hotspots come up after the app does, so the address list is not fixed.
  setInterval(refreshTrayMenu, 10000);
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const list = server && server.addresses ? server.addresses() : [];

  const addressItems = list.length
    ? list.map((a) => ({
        label: `Copy  ${a.app}`,
        click: () => clipboard.writeText(a.app)
      }))
    : [{ label: "No network — turn on Mobile Hotspot", enabled: false }];

  const caItems = list.length && server.secure
    ? [
        { type: "separator" },
        { label: "Trust profile (first time only)", enabled: false },
        ...list.map((a) => ({
          label: `Copy  ${a.ca}`,
          click: () => clipboard.writeText(a.ca)
        }))
      ]
    : [];

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show window", click: reveal },
    { type: "separator" },
    { label: "iPad address", enabled: false },
    ...addressItems,
    ...caItems,
    { type: "separator" },
    { label: "Quit", click: () => app.quit() }
  ]));
}

app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  if (tray && !tray.isDestroyed()) tray.destroy();
  if (server) { try { server.close(); } catch (e) {} }
});
