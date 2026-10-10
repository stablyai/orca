import { z } from 'zod'
import { structuredCloneMessageBytes } from './plugin-panel-message-budget'

/**
 * Live channel between a plugin's worker and its own sandboxed panels.
 * Panel side: `window.orcaPanel.postMessage(msg)` / `.onMessage(cb)`, injected
 * by the panel shell. Worker side: `panels.postMessage` / `panels.onMessage`.
 * Payloads are JSON values only; the host re-serializes them so no prototype,
 * getter, or non-JSON type crosses the boundary in either direction.
 */

/** Panel → host frame type (posted to `window.parent`). */
export const PANEL_LIVE_MESSAGE_TYPE = 'orca-panel-message'
/** Host → panel frame type (posted into the panel frame). */
export const PANEL_LIVE_DELIVERY_TYPE = 'orca-panel-host-message'

// Why no import from plugin-panel-bridge: the host API table imports this
// module, and the bridge imports the table, so a top-level import would cycle.
export const PANEL_LIVE_MESSAGE_MAX_BYTES = 64 * 1024
/** Worker → panel budget per plugin. Panel → worker traffic shares the
 *  panel bridge budget instead (PANEL_MESSAGE_RATE_LIMIT). */
export const PANEL_LIVE_MESSAGE_RATE_LIMIT = { maxMessages: 30, perMs: 1_000 }

const textEncoder = new TextEncoder()

export type PanelLiveMessageNormalization =
  | { ok: true; message: unknown }
  | { ok: false; error: string }

/** Copies `value` through JSON so only plain JSON data survives. The bounded
 *  size walk runs first so a huge or cyclic value never reaches stringify. */
export function normalizePanelLiveMessage(
  value: unknown,
  maxBytes = PANEL_LIVE_MESSAGE_MAX_BYTES
): PanelLiveMessageNormalization {
  if (structuredCloneMessageBytes(value, maxBytes) > maxBytes) {
    return { ok: false, error: 'panel message exceeds the size limit' }
  }
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    return { ok: false, error: 'panel message must be JSON-serializable' }
  }
  if (json === undefined) {
    return { ok: false, error: 'panel message must be JSON-serializable' }
  }
  if (textEncoder.encode(json).byteLength > maxBytes) {
    return { ok: false, error: 'panel message exceeds the size limit' }
  }
  return { ok: true, message: JSON.parse(json) }
}

/** Host-API params form: the transform hands handlers the normalized copy. */
export const panelLiveMessageSchema = z.unknown().transform((value, ctx) => {
  const normalized = normalizePanelLiveMessage(value)
  if (!normalized.ok) {
    ctx.addIssue({ code: 'custom', message: normalized.error })
    return z.NEVER
  }
  return normalized.message
})

/** Reads the payload of a panel → host live frame, or reports a non-match. */
export function readPanelLiveMessageFrame(
  data: unknown
): { matched: false } | { matched: true; message: unknown } {
  if (typeof data !== 'object' || data === null || !('type' in data)) {
    return { matched: false }
  }
  if (data.type !== PANEL_LIVE_MESSAGE_TYPE) {
    return { matched: false }
  }
  return { matched: true, message: 'message' in data ? data.message : undefined }
}
