import { EDITOR_METHODS, FRAME_EVENTS, type PluginFrameTheme } from './plugin-frame-bridge'
import { PLUGIN_ERROR_CODES, PLUGIN_PROTOCOL_VERSION } from './plugin-protocol'
import { PLUGIN_DECLARATIVE_POST_GLOBAL, PLUGIN_FRAME_TRANSPORT_GLOBAL } from './plugin-frame-guest'
import { PLUGIN_HOST_API_MAJOR } from '../workers/plugin-host-api-major'
import { PLUGIN_FRAME_FACADES_SCRIPT } from './plugin-panel-shell-facades'
import {
  PLUGIN_FRAME_USER_METHODS,
  pluginFrameMethodsFor,
  pluginHostApiMinorFor
} from '../workers/plugin-host-api'

/** Prepend CSP before any untrusted panel HTML: opaque origins alone still permit CORS fetch/beacons. Parsed CSP survives
 * DOM removal and later CSP can only tighten it. Open head/html exposes design tokens to plugin CSS.
 * Shared Electron-free builder keeps desktop and serve wrapping identical. */

// Residuals below apply only to the srcdoc iframe that browser clients (serve/web) still use;
// desktop frames are isolated guests (buildPluginGuestShellHtml, plugin-isolated-frames.md).
// Residual shared with doc preview: Electron 43 resolves `<link rel="dns-prefetch">` outside CSP
// and session hooks, so DNS labels can still leak.
// Residual WebRTC channel: the prelude removes RTCPeerConnection from the panel window only. A
// child `<iframe srcdoc>` (or `javascript:` src) the panel adds is a fresh realm: srcdoc commits
// without will-frame-navigate, so the frame guard never sees it, and Electron 43 has no CSP
// `webrtc` directive or per-frame switch. That frame can open TURN-over-TCP to any host, which
// `disable_non_proxied_udp` allows (plugin-panel-webrtc.electron.test.ts). Direct child-window
// access is already refused as a sandbox violation.
export const PLUGIN_PANEL_CSP =
  "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

/** Renderer fills theme/tokens before mounting srcdoc; main cannot know the active presentation values. */
export const PANEL_SHELL_TOKENS_PLACEHOLDER = '/*__ORCA_PANEL_TOKENS__*/'
export const PANEL_SHELL_COLOR_SCHEME_PLACEHOLDER = '__ORCA_COLOR_SCHEME__'
const PANEL_SHELL_TOKENS_STYLE_ID = 'orca-design-tokens'

export type PluginFrameSurface = 'panel' | 'editor'

/** How the frame script reaches the host: `window.parent` (srcdoc iframe) or the guest preload;
 *  a declarative host page also gets Orca's boot script a way to post `ui.*` events. */
type FrameTransport = 'parent' | 'guest' | 'declarative-guest'

/** The frozen `window.orca` every frame gets before plugin code runs: the public frame API.
 *  The envelope underneath is internal. `api` and `has` start from this host's table, so they work
 *  synchronously; `hello` confirms them and carries the theme. */
function frameApiScript(surface: PluginFrameSurface, transport: FrameTransport): string {
  const methods = pluginFrameMethodsFor(surface, transport !== 'parent')
  const config = JSON.stringify({
    protocol: PLUGIN_PROTOCOL_VERSION,
    surface,
    api: { major: PLUGIN_HOST_API_MAJOR, minor: pluginHostApiMinorFor(methods) },
    methods,
    codes: PLUGIN_ERROR_CODES,
    events: FRAME_EVENTS,
    editor: EDITOR_METHODS,
    // Iframes get no user-gesture API at all: Orca cannot verify their gestures. A components
    // panel's hidden guest never has activation; its `orca` module routes these through the
    // press grant with host.call instead.
    user: transport === 'guest' ? PLUGIN_FRAME_USER_METHODS : null,
    tokensStyleId: PANEL_SHELL_TOKENS_STYLE_ID,
    maxPending: 256,
    deadlineMs: 120_000,
    // A save dialog waits on the person, so gesture methods get a long deadline.
    userDeadlineMs: 30 * 60_000,
    userMethodList: Object.values(PLUGIN_FRAME_USER_METHODS),
    transportGlobal: transport === 'parent' ? null : PLUGIN_FRAME_TRANSPORT_GLOBAL,
    declarativePost: transport === 'declarative-guest' ? PLUGIN_DECLARATIVE_POST_GLOBAL : null
  }).replaceAll('<', '\\u003c')
  return `;(function (C) {
  var E = C.events
  var nextId = 0
  var pending = new Map()
  var listeners = new Map()
  var api = Object.freeze(C.api)
  var methods = C.methods.slice()
  var latest = null
  var waiting = []
  var locale = null
  var send = null
  if (C.transportGlobal) {
    // Why one-shot: the guest preload hands this over before any plugin script runs.
    var transport = null
    try { transport = window[C.transportGlobal]; delete window[C.transportGlobal] } catch (_) {}
    if (!transport || typeof transport.send !== 'function') return
    send = function (message) { transport.send(message) }
    transport.subscribe(receive)
  } else {
    var parent = window.parent
    send = function (message) { parent.postMessage(message, '*') }
    window.addEventListener('message', function (event) {
      if (event.source === parent) receive(event.data)
    })
  }
  function post(message) { send(Object.assign({ orca: C.protocol }, message)) }
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
    // Bounded and deadlined: a lost answer must never leave a call (or the map) growing forever.
    if (pending.size >= C.maxPending) return Promise.reject(failure({ code: 'rate_limited', message: 'too many calls in flight', retryable: true }))
    var id = nextId++
    var deadlineMs = C.userMethodList.indexOf(String(method)) >= 0 ? C.userDeadlineMs : C.deadlineMs
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (!pending.delete(id)) return
        if (signal) signal.removeEventListener('abort', abort)
        post({ kind: 'cancel', id: id })
        reject(failure({ code: 'timeout', message: 'host did not answer', retryable: true }))
      }, deadlineMs)
      function abort() {
        clearTimeout(timer)
        pending.delete(id)
        post({ kind: 'cancel', id: id })
        reject(failure({ code: 'cancelled', message: 'cancelled' }))
      }
      if (signal) signal.addEventListener('abort', abort, { once: true })
      pending.set(id, function (message) {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', abort)
        if (message.error) reject(failure(message.error))
        else resolve(message.result)
      })
      post({ kind: 'req', id: id, method: String(method), params: params })
    })
  }
  // Why checked here too: fail fast in the frame; the host re-checks before anything runs.
  function userCall(method, params) {
    var activation = navigator.userActivation
    if (!activation || !activation.isActive) {
      return Promise.reject(failure({ code: 'not_permitted', message: method + ' needs a click or key press in the frame' }))
    }
    return call(method, params)
  }
  function applyTheme(theme) {
    if (!theme || (theme.colorScheme !== 'light' && theme.colorScheme !== 'dark')) return
    document.documentElement.classList.remove('light', 'dark')
    document.documentElement.classList.add(theme.colorScheme)
    var tokens = document.getElementById(C.tokensStyleId)
    if (tokens && typeof theme.tokens === 'string') tokens.textContent = ':root{' + theme.tokens.replace(/[{}<>]/g, '') + '}'
    emit('theme', { colorScheme: theme.colorScheme })
  }
  function receive(m) {
    if (!m || m.orca !== C.protocol) return
    if (m.kind === 'res') {
      var settle = pending.get(m.id)
      if (settle) { pending.delete(m.id); settle(m) }
    } else if (m.kind === 'evt' && m.event === E.ping) {
      post({ kind: 'evt', event: E.pong, payload: m.payload })
    } else if (m.kind === 'evt' && m.event === E.hello && m.payload) {
      if (m.payload.api) api = Object.freeze({ major: m.payload.api.major, minor: m.payload.api.minor })
      if (Array.isArray(m.payload.methods)) methods = m.payload.methods.slice()
      if (typeof m.payload.locale === 'string') locale = m.payload.locale.slice(0, 64)
      applyTheme(m.payload.theme)
    } else if (m.kind === 'evt' && m.event === E.theme) {
      applyTheme(m.payload)
    } else if (m.kind === 'evt' && m.event === E.push) {
      receivePush(m.payload)
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
  }
  var orca = {
    host: Object.freeze({
      call: call,
      has: function (method) { return methods.indexOf(method) >= 0 }
    }),
    on: on
  }
${PLUGIN_FRAME_FACADES_SCRIPT}  if (C.user) {
    orca.shell = Object.freeze({
      openExternal: function (url) { return userCall(C.user.openExternal, { url: String(url) }) }
    })
    orca.files = Object.freeze({
      saveAs: function (options) {
        var o = options || {}
        var data = ArrayBuffer.isView(o.data)
          ? o.data.buffer.slice(o.data.byteOffset, o.data.byteOffset + o.data.byteLength)
          : o.data
        var params = { data: data }
        if (o.suggestedName !== undefined) params.suggestedName = o.suggestedName
        if (o.mimeType !== undefined) params.mimeType = o.mimeType
        return userCall(C.user.saveAs, params).then(function (result) {
          return { status: result && result.status === 'saved' ? 'saved' : 'cancelled' }
        })
      }
    })
  }
  Object.defineProperty(orca, 'api', { get: function () { return api }, enumerable: true })
  Object.defineProperty(orca, 'locale', {
    get: function () { return locale || navigator.language }, enumerable: true
  })
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
  if (C.declarativePost) {
    // One-shot for Orca's boot script, which deletes it before importing the plugin module.
    Object.defineProperty(window, C.declarativePost, { configurable: true, value: function (event, payload) {
      post({ kind: 'evt', event: String(event), payload: payload })
    } })
  }
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
    // Why: matching the host frame's inherited color-scheme avoids Chromium's opaque mismatch backdrop.
    '<style>:where(html.light){color-scheme:light}:where(html.dark){color-scheme:dark}</style>\n' +
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
  return `${prelude}${frameApiScript(surface, 'parent')}</script>\n</head>\n${pluginHtml}`
}

/** CSP header for every response of an isolated guest; the session, not CSP, denies the network. */
export const PLUGIN_GUEST_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "media-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; " +
  "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

/** An HTML document served to an isolated guest. Navigation, popups and WebRTC are fenced by
 *  main per guest, so only the frame API is injected; the theme arrives with `hello`. */
export function buildPluginGuestShellHtml(
  pluginHtml: string,
  surface: PluginFrameSurface = 'panel',
  options: { declarative?: boolean; theme?: PluginFrameTheme | null } = {}
): string {
  const transport = options.declarative ? 'declarative-guest' : 'guest'
  const theme = options.theme
  // Why baked in: plugins that read tokens at boot, and the first paint, must not wait for `hello`.
  const scheme =
    theme?.colorScheme === 'light' || theme?.colorScheme === 'dark' ? theme.colorScheme : ''
  const tokens = typeof theme?.tokens === 'string' ? theme.tokens.replace(/[{}<>]/g, '') : ''
  return (
    `<!doctype html>\n<html${scheme ? ` class="${scheme}"` : ''}>\n<head>\n<meta charset="utf-8">\n` +
    `<style id="${PANEL_SHELL_TOKENS_STYLE_ID}">:root{${tokens}}</style>\n` +
    `<script>\n'use strict'\n${frameApiScript(surface, transport)}</script>\n</head>\n${pluginHtml}`
  )
}
