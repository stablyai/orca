/**
 * Wire contract between Orca's worker API shim and main's per-session protocol handler.
 *
 * Why no preload: a service-worker preload crashes the renderer during GC (electron#52310), so
 * Orca runs its shim inside the worker itself and talks to main over fetch. Each extension
 * session handles the scheme, which tells main the session; the per-extension token, readable
 * only from that extension's own files, tells it the extension. Chromium sends no Origin to
 * protocol handlers, so the token is the caller identity.
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

const UNDEFINED_MARKER = '__orcaUndefined__'

/** JSON that keeps `undefined` (optional arguments in tuples, absent event args). */
export function encodeBrowserExtensionWireJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry === undefined ? UNDEFINED_MARKER : entry
  )
}

export function decodeBrowserExtensionWireJson(text: string): unknown {
  return JSON.parse(text, (_key, entry: unknown) =>
    entry === UNDEFINED_MARKER ? undefined : entry
  )
}
