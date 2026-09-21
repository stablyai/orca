// Hidden, offscreen Electron host for the rendered harness: the same Electron
// (and Chromium) the app ships, no window shown, no focus taken.
const { app, BrowserWindow } = require('electron')

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 1100,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
  })
  window.webContents.setFrameRate(10)
  await window.loadURL(process.env.HARNESS_URL)
})

app.on('window-all-closed', () => app.quit())
