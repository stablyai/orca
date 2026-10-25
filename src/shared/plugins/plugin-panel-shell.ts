import { PANEL_PING_TYPE, PANEL_PONG_TYPE } from './plugin-panel-bridge'

/** Prepend CSP before any untrusted panel HTML: opaque origins alone still permit CORS fetch/beacons. Parsed CSP survives
 * DOM removal and later CSP can only tighten it. Open head/html exposes design tokens to plugin CSS.
 * Shared Electron-free builder keeps desktop and serve wrapping identical. */

export const PLUGIN_PANEL_CSP =
  "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

/** Renderer fills theme/tokens before mounting srcdoc; main cannot know the active presentation values. */
export const PANEL_SHELL_TOKENS_PLACEHOLDER = '/*__ORCA_PANEL_TOKENS__*/'
export const PANEL_SHELL_COLOR_SCHEME_PLACEHOLDER = '__ORCA_COLOR_SCHEME__'

/** Expose only curated tokens: freezing all main.css properties would lock refactors. Additions are compatible;
 * renaming/removing published tokens breaks plugins. */
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

export function buildPluginPanelShellHtml(pluginHtml: string): string {
  // The inline ping responder proves the frame's event loop is alive; the
  // renderer watchdog demotes the panel when pongs stop arriving.
  const prelude =
    '<!doctype html>\n' +
    `<html class="${PANEL_SHELL_COLOR_SCHEME_PLACEHOLDER}">\n` +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_PANEL_CSP}">\n` +
    `<style>:root{${PANEL_SHELL_TOKENS_PLACEHOLDER}}</style>\n` +
    '<script>\n' +
    "'use strict'\n" +
    '// Host policy: plugin panels are documents, never browsing contexts.\n' +
    "if (window.navigation && typeof window.navigation.addEventListener === 'function') {\n" +
    "  window.navigation.addEventListener('navigate', function (event) {\n" +
    '    if (event.cancelable) event.preventDefault()\n' +
    '  })\n' +
    '}\n' +
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
    '}, true)\n' +
    "window.addEventListener('message', function (event) {\n" +
    '  var data = event.data\n' +
    `  if (event.source === window.parent && data && data.type === '${PANEL_PING_TYPE}') {\n` +
    `    window.parent.postMessage({ type: '${PANEL_PONG_TYPE}', pingId: data.pingId }, '*')\n` +
    '  }\n' +
    '})\n' +
    '</script>\n' +
    '</head>\n'
  return prelude + pluginHtml
}
