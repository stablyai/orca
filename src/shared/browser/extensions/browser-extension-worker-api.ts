/**
 * Wire contract between Orca's worker API shim and main's per-session protocol handler.
 *
 * Why no preload: a service-worker preload crashes the renderer during GC (electron#52310), so
 * Orca runs its shim inside the worker itself and talks to main over fetch. Each extension
 * session handles the scheme, which tells main the session. The request's initiator origin names
 * the extension, and the per-extension token, readable only from that extension's own files,
 * must match it, so a page that forges its initiator still lacks the token.
 */

export const BROWSER_EXTENSION_API_SCHEME = 'orca-extension-api'
export const BROWSER_EXTENSION_API_CALL_URL = `${BROWSER_EXTENSION_API_SCHEME}://api/call`
/** Long-lived NDJSON response carrying the worker's events; one per running worker. */
export const BROWSER_EXTENSION_API_EVENTS_URL = `${BROWSER_EXTENSION_API_SCHEME}://api/events`

// Files Orca writes into its own copy of an extension. Chromium reserves names starting with "_".
export const BROWSER_EXTENSION_WORKER_SHIM_FILE = 'orca-extension-api.js'
export const BROWSER_EXTENSION_WORKER_WRAPPER_FILE = 'orca-background.js'
export const BROWSER_EXTENSION_WORKER_TOKEN_FILE = 'orca-extension-api-token.json'
/** Orca's content script, listed first in each of the extension's isolated-world content scripts. */
export const BROWSER_EXTENSION_CONTENT_SCRIPT_FILE = 'orca-content-script-api.js'
/** The extension's own manifest, kept so a later shim or Orca update can rewrite from it. */
export const BROWSER_EXTENSION_ORIGINAL_MANIFEST_FILE = 'orca-original-manifest.json'

/** Body of every POST; `request` is a BrowserExtensionInvokeRequest for calls, absent for events. */
export type BrowserExtensionWorkerRequestBody = { token: string; request?: unknown }

// Why an escape: undefined is the lone ESCAPE, and a real string starting with it gains one more,
// so no extension string can decode as undefined.
const ESCAPE = '\u0000'

/** JSON that keeps `undefined` (optional arguments in tuples, absent event args). */
export function encodeBrowserExtensionWireJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry === undefined
      ? ESCAPE
      : typeof entry === 'string' && entry.startsWith(ESCAPE)
        ? ESCAPE + entry
        : entry
  )
}

export function decodeBrowserExtensionWireJson(text: string): unknown {
  return JSON.parse(text, (_key, entry: unknown) =>
    typeof entry !== 'string' || !entry.startsWith(ESCAPE)
      ? entry
      : entry === ESCAPE
        ? undefined
        : entry.slice(1)
  )
}
