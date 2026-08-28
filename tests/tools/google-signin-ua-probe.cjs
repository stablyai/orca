// Run with `node_modules/.bin/electron tests/tools/google-signin-ua-probe.cjs --mode=cleaned`.
const { app, BrowserWindow, session } = require('electron')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const MODES = new Set([
  'cleaned',
  'electron-auth',
  'electron-fixed',
  'firefox-auth',
  'firefox-fixed',
  // Replicates the SHIPPED app exactly (setupClientHintsOverride +
  // applyGoogleAuthUserAgent): Firefox UA is written to the WebContents on auth
  // navs and to the request header only for auth-host URLs; every other request
  // keeps whatever UA the WebContents carries. Logs incoming vs outgoing
  // identity for ALL requests to expose cross-host mismatches during the flow.
  'app-current',
  // Same, but with the STA-3811 fix: the header layer strips client hints on any
  // request already carrying the Firefox auth UA, regardless of destination host.
  'app-fixed'
])
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length)
if (!mode || !MODES.has(mode)) {
  throw new Error(`Expected --mode=${[...MODES].join('|')}`)
}

const headless = process.argv.includes('--headless')
const exitAfterMs = Number(
  process.argv.find((arg) => arg.startsWith('--exit-after-ms='))?.slice('--exit-after-ms='.length)
)

const profileRoot = mkdtempSync(join(tmpdir(), `orca-google-signin-${mode}-`))
const partition = `persist:google-signin-${mode}`
app.setPath('userData', profileRoot)

function log(event, details = {}) {
  process.stdout.write(
    `${JSON.stringify({ event, mode, at: new Date().toISOString(), ...details })}\n`
  )
}

function cleanElectronUserAgent(userAgent) {
  return userAgent.replace(/\s+Electron\/\S+/, '').replace(/(\)\s+)\S+\s+(Chrome\/)/, '$1$2')
}

function firefoxUserAgent() {
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10.15'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platform}; rv:140.0) Gecko/20100101 Firefox/140.0`
}

function isGoogleAuthUrl(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return hostname === 'accounts.google.com' || hostname === 'accounts.youtube.com'
  } catch {
    return false
  }
}

function safeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    return `${url.origin}${url.pathname}`
  } catch {
    return '<invalid>'
  }
}

function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return '<invalid>'
  }
}

// A Firefox UA paired with any sec-ch-ua header is the cross-host tell we hunt:
// real Firefox emits no client hints, so the two surfaces contradict each other.
function detectUaHintMismatch(headers) {
  const ua = headers['user-agent'] || ''
  const isFirefox = /Firefox\/\d/.test(ua) && !/Chrome\//.test(ua)
  const hasHints = Object.keys(headers).some((key) => key.startsWith('sec-ch-ua'))
  if (isFirefox && hasHints) {
    return 'firefox-ua-with-chrome-hints'
  }
  const isChrome = /Chrome\/\d/.test(ua)
  if (isChrome && !hasHints) {
    return 'chrome-ua-without-hints'
  }
  return null
}

function setHeader(headers, name, value) {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase())
  headers[existing ?? name] = value
}

function removeClientHints(headers) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith('sec-ch-ua')) {
      delete headers[key]
    }
  }
}

function applyChromeClientHints(headers, userAgent) {
  const fullVersion = userAgent.match(/Chrome\/([\d.]+)/)?.[1]
  if (!fullVersion) {
    return
  }
  const majorVersion = fullVersion.split('.')[0]
  setHeader(
    headers,
    'sec-ch-ua',
    `"Google Chrome";v="${majorVersion}", "Chromium";v="${majorVersion}", "Not/A)Brand";v="24"`
  )
  setHeader(
    headers,
    'sec-ch-ua-full-version-list',
    `"Google Chrome";v="${fullVersion}", "Chromium";v="${fullVersion}", "Not/A)Brand";v="24.0.0.0"`
  )
}

function identityForUrl(rawUrl, identities) {
  if (mode === 'electron-fixed') {
    return identities.native
  }
  if (mode === 'firefox-fixed') {
    return identities.firefox
  }
  if (isGoogleAuthUrl(rawUrl) && mode === 'electron-auth') {
    return identities.native
  }
  if (isGoogleAuthUrl(rawUrl) && mode === 'firefox-auth') {
    return identities.firefox
  }
  return identities.cleaned
}

function relevantHeaders(headers) {
  const result = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (lower === 'user-agent' || lower.startsWith('sec-ch-ua')) {
      result[lower] = value
    }
  }
  return result
}

app.whenReady().then(async () => {
  const browserSession = session.fromPartition(partition)
  await browserSession.clearStorageData()
  const identities = {
    native: browserSession.getUserAgent(),
    firefox: firefoxUserAgent()
  }
  identities.cleaned = cleanElectronUserAgent(identities.native)
  browserSession.setUserAgent(identityForUrl('about:blank', identities))

  const isAppMode = mode === 'app-current' || mode === 'app-fixed'

  browserSession.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
    const headers = details.requestHeaders
    const incoming = relevantHeaders(headers)

    if (isAppMode) {
      // Mirror setupClientHintsOverride: only auth-host URLs get the Firefox UA
      // header + hint strip; every other request keeps its incoming UA (which is
      // the WebContents UA — Firefox while the auth document is on screen).
      if (isGoogleAuthUrl(details.url)) {
        setHeader(headers, 'user-agent', identities.firefox)
        removeClientHints(headers)
      } else {
        const currentUa = incoming['user-agent']
        // STA-3811 fix: a request already carrying the Firefox auth UA came from
        // the auth document; real Firefox sends no client hints, so strip them
        // instead of rewriting to Chrome — keeping UA and hints one story.
        if (mode === 'app-fixed' && currentUa === identities.firefox) {
          removeClientHints(headers)
        } else {
          // Real setupClientHintsOverride builds Chrome hints once from the
          // session's cleaned UA (a closure), never from the per-request UA.
          applyChromeClientHints(headers, identities.cleaned)
        }
      }
      const outgoing = relevantHeaders(headers)
      const uaMismatch = detectUaHintMismatch(outgoing)
      log('request', {
        url: safeUrl(details.url),
        host: hostOf(details.url),
        resourceType: details.resourceType,
        isAuthHost: isGoogleAuthUrl(details.url),
        incoming,
        outgoing,
        uaHintMismatch: uaMismatch
      })
      callback({ requestHeaders: headers })
      return
    }

    const identity = identityForUrl(details.url, identities)
    setHeader(headers, 'user-agent', identity)
    if (identity === identities.firefox) {
      removeClientHints(headers)
    } else if (identity === identities.cleaned) {
      applyChromeClientHints(headers, identity)
    }
    if (details.resourceType === 'mainFrame') {
      log('main-frame-request', {
        url: safeUrl(details.url),
        headers: relevantHeaders(headers)
      })
    }
    callback({ requestHeaders: headers })
  })

  if (Number.isFinite(exitAfterMs) && exitAfterMs > 0) {
    setTimeout(() => {
      log('exit', { reason: 'timeout', exitAfterMs })
      app.quit()
    }, exitAfterMs)
  }

  const window = new BrowserWindow({
    show: !headless,
    title: `Google sign-in UA probe: ${mode}`,
    width: 980,
    height: 840,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition,
      sandbox: true
    }
  })

  window.webContents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
    if (!isMainFrame) {
      return
    }
    if (isAppMode) {
      // Mirror applyGoogleAuthUserAgent: Firefox UA on auth navs, restore the
      // cleaned session UA otherwise. This WebContents UA is what leaks onto
      // cross-host subresource requests while the auth document is on screen.
      const current = window.webContents.getUserAgent()
      if (isGoogleAuthUrl(url)) {
        if (current !== identities.firefox) {
          window.webContents.setUserAgent(identities.firefox)
        }
      } else if (current === identities.firefox) {
        window.webContents.setUserAgent(identities.cleaned)
      }
      log('main-frame-navigation', {
        url: safeUrl(url),
        appliedUserAgent: window.webContents.getUserAgent()
      })
      return
    }
    const identity = identityForUrl(url, identities)
    if (window.webContents.getUserAgent() !== identity) {
      window.webContents.setUserAgent(identity)
    }
    log('main-frame-navigation', { url: safeUrl(url), appliedUserAgent: identity })
  })
  window.webContents.on('did-finish-load', async () => {
    try {
      const identity = await window.webContents.executeJavaScript(`({
        userAgent: navigator.userAgent,
        userAgentData: navigator.userAgentData ? {
          brands: navigator.userAgentData.brands,
          mobile: navigator.userAgentData.mobile,
          platform: navigator.userAgentData.platform
        } : null
      })`)
      log('document-identity', { url: safeUrl(window.webContents.getURL()), ...identity })
    } catch (error) {
      log('document-identity-error', { error: String(error) })
    }
  })

  log('ready', {
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    profileRoot,
    nativeUserAgent: identities.native,
    cleanedUserAgent: identities.cleaned,
    firefoxUserAgent: identities.firefox
  })
  await window.loadURL('https://accounts.google.com/')
})
