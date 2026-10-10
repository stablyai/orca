import { PANEL_PING_TYPE, PANEL_PONG_TYPE } from './plugin-panel-bridge'
import { PANEL_LIVE_DELIVERY_TYPE, PANEL_LIVE_MESSAGE_TYPE } from './plugin-panel-live-message'

/**
 * Host-generated shell wrapped around plugin panel HTML before it is handed
 * to the sandboxed iframe. The shell's job is to make the CSP parse BEFORE
 * any plugin content does: an opaque-origin sandboxed iframe without a CSP
 * can still fetch() CORS-permissive endpoints and beacon data out via <img>.
 *
 * Prepending works because (a) a CSP <meta> applies from the moment it
 * parses and cannot be un-applied by later markup or DOM removal, and (b) a
 * second CSP meta from the plugin can only intersect (tighten), never loosen.
 * The plugin document merges into the shell's open <head>/<html>, so design
 * tokens defined here are visible to plugin CSS as ordinary custom
 * properties.
 *
 * Electron-free string builder: desktop main and headless serve both wrap
 * panel HTML through this one function.
 */

export const PLUGIN_PANEL_CSP =
  "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

/** Renderer-substituted placeholders. Main cannot know the renderer's theme
 *  or token values; the renderer replaces these with a color-scheme class and
 *  CSS custom-property declarations before mounting the srcdoc. */
export const PANEL_SHELL_TOKENS_PLACEHOLDER = '/*__ORCA_PANEL_TOKENS__*/'
export const PANEL_SHELL_COLOR_SCHEME_PLACEHOLDER = '__ORCA_COLOR_SCHEME__'

/** Curated design-token subset injected into panel documents. Deliberately
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

export function buildPluginPanelShellHtml(pluginHtml: string): string {
  // The inline ping responder proves the frame's event loop is alive; the
  // renderer watchdog demotes the panel when pongs stop arriving. It shares one
  // listener with the `window.orcaPanel` live-message bridge.
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
    '// Live channel to the plugin worker; the host relays JSON copies only.\n' +
    ';(function () {\n' +
    '  var listeners = []\n' +
    '  var orcaPanel = Object.freeze({\n' +
    '    postMessage: function (message) {\n' +
    `      window.parent.postMessage({ type: '${PANEL_LIVE_MESSAGE_TYPE}', message: message }, '*')\n` +
    '    },\n' +
    '    onMessage: function (listener) {\n' +
    "      if (typeof listener !== 'function') throw new TypeError('orcaPanel.onMessage expects a function')\n" +
    '      listeners.push(listener)\n' +
    '      return function () {\n' +
    '        var index = listeners.indexOf(listener)\n' +
    '        if (index !== -1) listeners.splice(index, 1)\n' +
    '      }\n' +
    '    }\n' +
    '  })\n' +
    "  try { Object.defineProperty(window, 'orcaPanel', { value: orcaPanel, writable: false, configurable: false }) }\n" +
    '  catch (_) { window.orcaPanel = orcaPanel }\n' +
    "  window.addEventListener('message', function (event) {\n" +
    '    var data = event.data\n' +
    '    if (event.source !== window.parent || !data) return\n' +
    `    if (data.type === '${PANEL_PING_TYPE}') {\n` +
    `      window.parent.postMessage({ type: '${PANEL_PONG_TYPE}', pingId: data.pingId }, '*')\n` +
    `    } else if (data.type === '${PANEL_LIVE_DELIVERY_TYPE}') {\n` +
    '      listeners.slice().forEach(function (listener) {\n' +
    '        try { listener(data.message) } catch (error) { setTimeout(function () { throw error }) }\n' +
    '      })\n' +
    '    }\n' +
    '  })\n' +
    '})()\n' +
    '</script>\n' +
    '</head>\n'
  return prelude + pluginHtml
}
