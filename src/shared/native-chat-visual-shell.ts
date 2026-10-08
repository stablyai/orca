import { PANEL_DESIGN_TOKEN_ALLOWLIST } from './plugins/plugin-panel-shell'

/**
 * The document wrapped around an agent-written chat visual before it enters its sandboxed frame.
 * Same placement rule as the plugin panel shell: the CSP meta parses before any visual markup, so
 * nothing later in the document can loosen it, and the visual's own <html>/<head> merge into ours.
 *
 * Network: scripts, styles, fonts and images may load from a pinned set of public CDNs; nothing may
 * fetch, open sockets, frame, or submit. A page can still encode data in a request to an allowed
 * CDN — an accepted, disclosed risk, not a guarantee that no data leaves.
 *
 * Electron-free string builder: desktop, the web client and mobile build the same document.
 */

export const NATIVE_CHAT_VISUAL_CDN_ORIGINS = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
  'https://esm.sh',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com'
] as const

const ASSET_SOURCES = `'unsafe-inline' data: blob: ${NATIVE_CHAT_VISUAL_CDN_ORIGINS.join(' ')}`
const MEDIA_SOURCES = `data: blob: ${NATIVE_CHAT_VISUAL_CDN_ORIGINS.join(' ')}`

export const NATIVE_CHAT_VISUAL_CSP = [
  "default-src 'none'",
  `script-src ${ASSET_SOURCES}`,
  `style-src ${ASSET_SOURCES}`,
  `font-src ${MEDIA_SOURCES}`,
  `img-src ${MEDIA_SOURCES}`,
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

/** Frame names carry this prefix so the main process registers them before content runs. */
export const NATIVE_CHAT_VISUAL_FRAME_NAME_PREFIX = 'orca-chat-visual:'

export const NATIVE_CHAT_VISUAL_SIZE_TYPE = 'orca-visual-size'
export const NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE = 'orca-visual-open-link'
export const NATIVE_CHAT_VISUAL_THEME_TYPE = 'orca-visual-theme'

export const NATIVE_CHAT_VISUAL_MIN_HEIGHT = 80
export const NATIVE_CHAT_VISUAL_MAX_HEIGHT = 2000
const MAX_LINK_LENGTH = 2048

/** Theme variables a visual may style against: the plugin panel set plus the chart series. */
export const NATIVE_CHAT_VISUAL_THEME_TOKENS = [
  ...PANEL_DESIGN_TOKEN_ALLOWLIST,
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--font-sans',
  '--font-mono'
] as const

export type NativeChatVisualTheme = {
  colorScheme: 'light' | 'dark'
  tokens: Readonly<Record<string, string>>
}

const TOKEN_NAME_PATTERN = /^--[a-z0-9-]+$/

/** Token values land inside a <style> block, so structural characters are stripped. */
function sanitizeTokenValue(value: string): string {
  return value.replaceAll(/[{}<>;\\]/g, '').trim()
}

export function nativeChatVisualThemeCss(theme: NativeChatVisualTheme): string {
  const declarations = [`color-scheme:${theme.colorScheme === 'dark' ? 'dark' : 'light'}`]
  for (const [name, value] of Object.entries(theme.tokens)) {
    const clean = sanitizeTokenValue(value)
    if (TOKEN_NAME_PATTERN.test(name) && clean.length > 0) {
      declarations.push(`${name}:${clean}`)
    }
  }
  return `:root{${declarations.join(';')}}`
}

// A visual sits in the reply on the thread's own background; its scrollbar stays hidden because the
// frame grows to fit it. The visual's own CSS comes later and wins.
const BASE_CSS =
  'html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);' +
  'font-size:14px;line-height:1.5;scrollbar-width:none}html::-webkit-scrollbar{display:none}' +
  'body{margin:0}code,pre,kbd,samp{font-family:var(--font-mono)}'

function bootstrapScript(channel: string): string {
  const constants = JSON.stringify({
    channel,
    size: NATIVE_CHAT_VISUAL_SIZE_TYPE,
    link: NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE,
    theme: NATIVE_CHAT_VISUAL_THEME_TYPE
  })
  // Plain ES5 so it runs before, and independent of, anything the visual loads.
  return `(function () {
'use strict'
var C = ${constants}
var host = window.parent
function send(message) {
  message.channel = C.channel
  try { host.postMessage(message, '*') } catch (_) {}
}
// Containment: a visual is a document, never a browsing context. The host also refuses navigation.
if (window.navigation && typeof window.navigation.addEventListener === 'function') {
  window.navigation.addEventListener('navigate', function (event) {
    if (!event.hashChange && event.cancelable) event.preventDefault()
  })
}
try { Object.defineProperty(window, 'open', { value: function () { return null }, writable: false, configurable: false }) }
catch (_) { try { window.open = function () { return null } } catch (_) {} }
document.addEventListener('click', function (event) {
  var node = event.target
  while (node && node.nodeType !== 1) node = node.parentNode
  var anchor = node && node.closest ? node.closest('a[href]') : null
  if (!anchor) return
  var href = anchor.getAttribute('href') || ''
  if (href.charAt(0) === '#') return
  event.preventDefault()
  if (!event.isTrusted) return
  var url
  try { url = new URL(href, document.baseURI) } catch (_) { return }
  if (url.protocol === 'http:' || url.protocol === 'https:') send({ type: C.link, url: url.href })
}, true)
document.addEventListener('submit', function (event) { event.preventDefault() }, true)
// Theme: only the host window may restyle the visual.
var themeStyle = document.getElementById('orca-visual-theme')
window.addEventListener('message', function (event) {
  var data = event.data
  if (event.source !== host || !data || data.type !== C.theme || data.channel !== C.channel) return
  if (typeof data.css !== 'string' || !themeStyle) return
  themeStyle.textContent = data.css
  document.documentElement.classList.toggle('dark', data.colorScheme === 'dark')
})
// Height: report the document's own height whenever layout changes; the host fits the frame.
var reported = -1
var pending = false
function measure() {
  pending = false
  var height = document.documentElement.getBoundingClientRect().height
  var body = document.body
  // A page pinned to the frame (html/body height 100%) overflows its body instead of growing it;
  // add only what overflows, so a padded full-height body does not grow the frame by itself.
  if (body && body.scrollHeight > body.clientHeight) height += body.scrollHeight - body.clientHeight
  height = Math.ceil(height)
  if (height !== reported && height > 0) {
    reported = height
    send({ type: C.size, height: height })
  }
}
function schedule() {
  if (pending) return
  pending = true
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(measure)
  else setTimeout(measure, 16)
}
if (typeof ResizeObserver === 'function') {
  var observer = new ResizeObserver(schedule)
  observer.observe(document.documentElement)
  document.addEventListener('DOMContentLoaded', function () { if (document.body) observer.observe(document.body) })
}
// Content that overflows a fixed-size body changes no observed box, so watch the content too.
if (typeof MutationObserver === 'function') {
  document.addEventListener('DOMContentLoaded', function () {
    if (document.body) new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
  })
}
document.addEventListener('DOMContentLoaded', schedule)
window.addEventListener('load', schedule)
if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule)
})()`
}

/**
 * The full srcdoc for one visual. `channel` is unique per built document and rides on every message
 * the shell sends, so the host can tell this document's messages from anything else.
 */
export function buildNativeChatVisualDocument(args: {
  html: string
  channel: string
  theme: NativeChatVisualTheme
}): string {
  const scheme = args.theme.colorScheme === 'dark' ? 'dark' : 'light'
  return `<!doctype html>
<html class="${scheme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${NATIVE_CHAT_VISUAL_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style id="orca-visual-theme">${nativeChatVisualThemeCss(args.theme)}</style>
<style>${BASE_CSS}</style>
<script>${bootstrapScript(args.channel)}</script>
</head>
${args.html}`
}

export type NativeChatVisualFrameMessage =
  | { kind: 'size'; height: number }
  | { kind: 'open-link'; url: string }

/** A message from a visual's shell, validated; null for anything else. */
export function readNativeChatVisualFrameMessage(
  data: unknown,
  channel: string
): NativeChatVisualFrameMessage | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }
  if (!('channel' in data) || data.channel !== channel || !('type' in data)) {
    return null
  }
  if (data.type === NATIVE_CHAT_VISUAL_SIZE_TYPE) {
    const height = 'height' in data ? data.height : undefined
    return typeof height === 'number' && Number.isFinite(height) && height > 0
      ? { kind: 'size', height }
      : null
  }
  if (data.type === NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE) {
    const url = 'url' in data ? data.url : undefined
    if (typeof url !== 'string' || url.length > MAX_LINK_LENGTH) {
      return null
    }
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? { kind: 'open-link', url: parsed.href }
        : null
    } catch {
      return null
    }
  }
  return null
}

export function clampNativeChatVisualHeight(height: number): number {
  return Math.min(
    NATIVE_CHAT_VISUAL_MAX_HEIGHT,
    Math.max(NATIVE_CHAT_VISUAL_MIN_HEIGHT, Math.round(height))
  )
}

export function nativeChatVisualThemeMessage(
  theme: NativeChatVisualTheme,
  channel: string
): { type: string; channel: string; css: string; colorScheme: 'light' | 'dark' } {
  return {
    type: NATIVE_CHAT_VISUAL_THEME_TYPE,
    channel,
    css: nativeChatVisualThemeCss(theme),
    colorScheme: theme.colorScheme
  }
}
