import { EDITOR_METHODS, FRAME_EVENTS } from './plugin-frame-bridge'
import { PLUGIN_ERROR_CODES, PLUGIN_PROTOCOL_VERSION } from './plugin-protocol'
import { PLUGIN_HOST_API_MAJOR } from '../workers/plugin-host-api-major'
import { PLUGIN_HOST_API_MINOR, pluginHostMethodsFor } from '../workers/plugin-host-api'

/** Prepend CSP before any untrusted panel HTML: opaque origins alone still permit CORS fetch/beacons. Parsed CSP survives
 * DOM removal and later CSP can only tighten it. Open head/html exposes design tokens to plugin CSS.
 * Shared Electron-free builder keeps desktop and serve wrapping identical. */

// Residual shared with doc preview: Electron 43 resolves `<link rel="dns-prefetch">` outside CSP
// and session hooks (see browser-route-dns-prefetch.electron.test.ts), so DNS labels can still leak.
// Residual WebRTC channel: the prelude removes RTCPeerConnection from the panel window only. A
// child `<iframe srcdoc>` (or `javascript:` src) the panel adds is a fresh realm: srcdoc commits
// without will-frame-navigate, so the frame guard never sees it, and Electron 43 has no CSP
// `webrtc` directive or per-frame switch. That frame can open TURN-over-TCP to any host, which
// `disable_non_proxied_udp` allows (plugin-panel-webrtc.electron.test.ts). Direct child-window
// access is already refused as a sandbox violation. A subframe preload (nodeIntegrationInSubFrames
// on the main window) would cover srcdoc frames but, tested, still misses `javascript:` documents.
export const PLUGIN_PANEL_CSP =
  "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

/** Renderer fills theme/tokens before mounting srcdoc; main cannot know the active presentation values. */
export const PANEL_SHELL_TOKENS_PLACEHOLDER = '/*__ORCA_PANEL_TOKENS__*/'
export const PANEL_SHELL_COLOR_SCHEME_PLACEHOLDER = '__ORCA_COLOR_SCHEME__'
const PANEL_SHELL_TOKENS_STYLE_ID = 'orca-design-tokens'

/** Curated design-token subset injected into panel documents as `--orca-<name>`. Deliberately
 *  NOT all of main.css (~257 custom properties): freezing every token as
 *  public API would lock future refactors. Grow additively; renaming or
 *  dropping an entry here is a plugin-facing breaking change. */
export const PANEL_DESIGN_TOKEN_ALLOWLIST = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--border',
  '--input',
  '--ring',
  '--radius'
] as const

export type PluginFrameSurface = 'panel' | 'editor'

/** The frozen `window.orca` every frame gets before plugin code runs: the public frame API.
 *  The envelope underneath is internal. `api` and `has` start from this host's table, so they work
 *  synchronously; `hello` confirms them and carries the theme. */
function frameApiScript(surface: PluginFrameSurface): string {
  const config = JSON.stringify({
    protocol: PLUGIN_PROTOCOL_VERSION,
    surface,
    api: { major: PLUGIN_HOST_API_MAJOR, minor: PLUGIN_HOST_API_MINOR },
    methods: pluginHostMethodsFor(surface),
    codes: PLUGIN_ERROR_CODES,
    events: FRAME_EVENTS,
    editor: EDITOR_METHODS,
    tokensStyleId: PANEL_SHELL_TOKENS_STYLE_ID
  }).replaceAll('<', '\\u003c')
  return `;(function (C) {
  var parent = window.parent
  var E = C.events
  var nextId = 0
  var pending = new Map()
  var listeners = new Map()
  var api = Object.freeze(C.api)
  var methods = C.methods.slice()
  var latest = null
  var waiting = []
  function post(message) { parent.postMessage(Object.assign({ orca: C.protocol }, message), '*') }
  function failure(error) {
    var e = new Error(String(error && error.message || 'host call failed'))
    e.code = C.codes.indexOf(error && error.code) >= 0 ? error.code : 'action_failed'
    e.retryable = Boolean(error && error.retryable)
    if (error && typeof error.retryAfterMs === 'number') e.retryAfterMs = error.retryAfterMs
    return e
  }
  function emit(name, payload) {
    var set = listeners.get(name)
    return set ? Array.from(set).map(function (fn) {
      try { return Promise.resolve(fn(payload)) } catch (e) { return Promise.reject(e) }
    }) : []
  }
  function on(name, fn) {
    if (typeof fn !== 'function') throw new TypeError('orca.on needs a handler')
    var set = listeners.get(name) || new Set()
    listeners.set(name, set)
    var entry = function (payload) { return fn(payload) }
    set.add(entry)
    return Object.freeze({ dispose: function () { set.delete(entry) } })
  }
  function call(method, params, options) {
    var signal = options && options.signal
    if (signal && signal.aborted) return Promise.reject(failure({ code: 'cancelled', message: 'cancelled' }))
    var id = nextId++
    return new Promise(function (resolve, reject) {
      function abort() {
        pending.delete(id)
        post({ kind: 'cancel', id: id })
        reject(failure({ code: 'cancelled', message: 'cancelled' }))
      }
      if (signal) signal.addEventListener('abort', abort, { once: true })
      pending.set(id, function (message) {
        if (signal) signal.removeEventListener('abort', abort)
        if (message.error) reject(failure(message.error))
        else resolve(message.result)
      })
      post({ kind: 'req', id: id, method: String(method), params: params })
    })
  }
  function applyTheme(theme) {
    if (!theme || (theme.colorScheme !== 'light' && theme.colorScheme !== 'dark')) return
    document.documentElement.classList.remove('light', 'dark')
    document.documentElement.classList.add(theme.colorScheme)
    var tokens = document.getElementById(C.tokensStyleId)
    if (tokens && typeof theme.tokens === 'string') tokens.textContent = ':root{' + theme.tokens.replace(/[{}<>]/g, '') + '}'
    emit('theme', { colorScheme: theme.colorScheme })
  }
  window.addEventListener('message', function (event) {
    var m = event.data
    if (event.source !== parent || !m || m.orca !== C.protocol) return
    if (m.kind === 'res') {
      var settle = pending.get(m.id)
      if (settle) { pending.delete(m.id); settle(m) }
    } else if (m.kind === 'evt' && m.event === E.ping) {
      post({ kind: 'evt', event: E.pong, payload: m.payload })
    } else if (m.kind === 'evt' && m.event === E.hello && m.payload) {
      if (m.payload.api) api = Object.freeze({ major: m.payload.api.major, minor: m.payload.api.minor })
      if (Array.isArray(m.payload.methods)) methods = m.payload.methods.slice()
      applyTheme(m.payload.theme)
    } else if (m.kind === 'evt' && m.event === E.theme) {
      applyTheme(m.payload)
    } else if (m.kind === 'evt' && m.event === E.editorDocument && C.surface === 'editor') {
      latest = Object.freeze(m.payload)
      waiting.splice(0).forEach(function (resolve) { resolve(latest) })
      emit(E.editorDocument, latest)
    } else if (m.kind === 'evt') {
      emit(m.event, m.payload)
    } else if (m.kind === 'req') {
      Promise.all(emit(m.method, m.params)).then(function () {
        post({ kind: 'res', id: m.id, result: null })
      }, function (e) {
        post({ kind: 'res', id: m.id, error: { code: 'action_failed', message: String(e && e.message || e), retryable: false } })
      })
    }
  })
  var orca = {
    host: Object.freeze({
      call: call,
      has: function (method) { return methods.indexOf(method) >= 0 }
    }),
    on: on
  }
  Object.defineProperty(orca, 'api', { get: function () { return api }, enumerable: true })
  if (C.surface === 'editor') {
    orca.document = Object.freeze({
      get: function () {
        return latest ? Promise.resolve(latest) : new Promise(function (resolve) { waiting.push(resolve) })
      },
      // Why replay: editors often subscribe after their bundle loads, when the first document is in.
      onDidChange: function (fn) {
        var subscription = on(E.editorDocument, fn)
        var current = latest
        if (current) Promise.resolve().then(function () { if (latest === current) fn(current) })
        return subscription
      },
      applyEdit: function (edit) { return call(C.editor.applyEdit, edit) }
    })
    window.addEventListener('keydown', function (event) {
      if (event.repeat || !(event.metaKey || event.ctrlKey)) return
      post({ kind: 'evt', event: E.editorKeydown, payload: {
        key: String(event.key).slice(0, 64), code: String(event.code).slice(0, 64),
        metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey
      } })
    }, true)
  }
  Object.defineProperty(window, 'orca', { value: Object.freeze(orca), writable: false, configurable: false })
  post({ kind: 'evt', event: E.ready, payload: { protocol: C.protocol } })
})(${config})
`
}

export function buildPluginPanelShellHtml(
  pluginHtml: string,
  surface: PluginFrameSurface = 'panel'
): string {
  const prelude =
    '<!doctype html>\n' +
    `<html class="${PANEL_SHELL_COLOR_SCHEME_PLACEHOLDER}">\n` +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_PANEL_CSP}">\n` +
    `<style id="${PANEL_SHELL_TOKENS_STYLE_ID}">:root{${PANEL_SHELL_TOKENS_PLACEHOLDER}}</style>\n` +
    '<script>\n' +
    "'use strict'\n" +
    '// Host policy: plugin panels are documents, never browsing contexts.\n' +
    "if (window.navigation && typeof window.navigation.addEventListener === 'function') {\n" +
    "  window.navigation.addEventListener('navigate', function (event) {\n" +
    '    if (event.cancelable) event.preventDefault()\n' +
    '  })\n' +
    '}\n' +
    '// Why: CSP has no WebRTC directive, so a peer connection would be an open outbound channel.\n' +
    "['RTCPeerConnection', 'webkitRTCPeerConnection'].forEach(function (name) {\n" +
    '  try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }) }\n' +
    '  catch (_) {}\n' +
    '})\n' +
    "try { Object.defineProperty(window, 'open', { value: function () { return null }, writable: false, configurable: false }) }\n" +
    'catch (_) { try { window.open = function () { return null } } catch (_) {} }\n' +
    "window.addEventListener('click', function (event) {\n" +
    '  var node = event.target\n' +
    '  while (node && node !== document) {\n' +
    "    if (node.nodeType === 1 && node.tagName === 'A' && node.hasAttribute('href')) {\n" +
    '      event.preventDefault()\n' +
    '      event.stopImmediatePropagation()\n' +
    '      return\n' +
    '    }\n' +
    '    node = node.parentNode\n' +
    '  }\n' +
    '}, true)\n' +
    "window.addEventListener('submit', function (event) {\n" +
    '  event.preventDefault()\n' +
    '  event.stopImmediatePropagation()\n' +
    '}, true)\n'
  return `${prelude}${frameApiScript(surface)}</script>\n</head>\n${pluginHtml}`
}
