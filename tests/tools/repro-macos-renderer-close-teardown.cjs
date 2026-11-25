#!/usr/bin/env node
const { app, BrowserWindow, ipcMain } = require('electron')

const modeArg = process.argv.find((arg) => arg.startsWith('--mode='))
const mode = modeArg ? modeArg.slice('--mode='.length) : 'natural-close'
const timeoutArg = process.argv.find((arg) => arg.startsWith('--timeout-ms='))
const timeoutMs = timeoutArg ? Number(timeoutArg.slice('--timeout-ms='.length)) : 5000

const validModes = new Set([
  'natural-close',
  'sigkill-after-confirmed-close',
  'sigkill-during-native-close',
  'sigkill-before-close'
])

if (!validModes.has(mode) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error(
    JSON.stringify({
      event: 'invalid-args',
      mode,
      validModes: Array.from(validModes),
      timeoutMs
    })
  )
  process.exit(2)
}

let win = null
let closeConfirmed = false
let windowClosing = false
let rendererPid = 0
let renderProcessGoneDetails = null
let crashRecorderWouldRunBeforeFix = false
let crashRecorderWouldRunAfterFix = false
let timeout = null

function log(event, data = {}) {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event,
      mode,
      closeConfirmed,
      windowClosing,
      rendererPid,
      ...data
    })
  )
}

function finish(exitCode = 0) {
  if (timeout) {
    clearTimeout(timeout)
    timeout = null
  }
  log('summary', {
    renderProcessGoneDetails,
    crashRecorderWouldRunBeforeFix,
    crashRecorderWouldRunAfterFix
  })
  setTimeout(() => {
    if (win && !win.isDestroyed()) {
      win.destroy()
    }
    app.exit(exitCode)
  }, 50)
}

function killRenderer(reason) {
  if (!rendererPid) {
    log('kill-renderer-skipped', { reason, skipped: 'missing-renderer-pid' })
    return
  }
  try {
    process.kill(rendererPid, 'SIGKILL')
    log('sent-sigkill', { reason })
  } catch (error) {
    log('sent-sigkill-failed', {
      reason,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error)
    })
  }
}

app.on('child-process-gone', (_event, details) => {
  log('child-process-gone', { details })
})

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 420,
    height: 220,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    renderProcessGoneDetails = details
    crashRecorderWouldRunBeforeFix = true
    crashRecorderWouldRunAfterFix = !windowClosing
    log('render-process-gone', {
      details,
      crashRecorderWouldRunBeforeFix,
      crashRecorderWouldRunAfterFix
    })
    finish()
  })

  win.webContents.on('destroyed', () => {
    log('webcontents-destroyed')
  })

  win.on('close', (event) => {
    log('window-close')
    if (!closeConfirmed) {
      event.preventDefault()
      log('window-close-prevented-pending-confirm')
      win.webContents.send('harness:close-requested')
      return
    }

    windowClosing = true
    log('window-close-confirmed')

    if (mode === 'sigkill-after-confirmed-close') {
      event.preventDefault()
      killRenderer('after-confirmed-close')
    } else if (mode === 'sigkill-during-native-close') {
      killRenderer('during-native-close')
    }
  })

  win.on('closed', () => {
    log('window-closed')
    if (!renderProcessGoneDetails) {
      finish()
    }
  })

  ipcMain.on('harness:confirm-close', () => {
    closeConfirmed = true
    log('renderer-confirmed-close')
    if (mode === 'sigkill-before-close') {
      killRenderer('before-close')
    } else {
      win.close()
    }
  })

  await win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html>
<html>
  <body>
    <main>renderer close teardown repro</main>
    <script>
      const { ipcRenderer } = require('electron')
      ipcRenderer.on('harness:close-requested', () => {
        ipcRenderer.send('harness:confirm-close')
      })
    </script>
  </body>
</html>
`)}`
  )

  rendererPid = win.webContents.getOSProcessId()
  log('loaded')
  timeout = setTimeout(() => {
    log('timeout')
    finish(1)
  }, timeoutMs)

  setTimeout(() => {
    log('requesting-close')
    win.close()
  }, 100)
})
