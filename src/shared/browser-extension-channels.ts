/**
 * Wire contract between the extension page preload and main's API host.
 *
 * Pages invoke through ipcMain; extension service workers send the same request payloads over
 * the worker protocol (browser-extension-worker-api.ts). The sandboxed preload writes these names
 * out itself (it cannot load shared chunks); a test pins the two copies together.
 */

/** Extension context → main. Payload: BrowserExtensionInvokeRequest; reply: BrowserExtensionInvokeResult. */
export const BROWSER_EXTENSION_INVOKE_CHANNEL = 'browserExtension:invoke'

/** Main → extension context, only for events that context registered. Payload: BrowserExtensionEventPayload. */
export const BROWSER_EXTENSION_EVENT_CHANNEL = 'browserExtension:event'

export type BrowserExtensionInvokeRequest =
  | { type: 'call'; namespace: string; method: string; args: unknown[] }
  // Why: lets main skip contexts with no listener and restart a stopped worker only when it listens.
  | { type: 'listen'; namespace: string; event: string; active: boolean }

export type BrowserExtensionInvokeResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

export type BrowserExtensionEventPayload = {
  namespace: string
  event: string
  args: unknown[]
}
