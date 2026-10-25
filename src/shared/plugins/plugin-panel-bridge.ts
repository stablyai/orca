import { z } from 'zod'
import { isPluginPanelAction } from './plugin-host-api'

/** Opaque-origin sandbox panels cannot authenticate by origin. Verify sender window and payload; main rechecks capabilities.
 * Transport uses host API params/results rather than a second contract. */

export const PANEL_ACTION_REQUEST_TYPE = 'orca-panel-action'
export const PANEL_ACTION_RESULT_TYPE = 'orca-panel-action-result'
export const PANEL_PING_TYPE = 'orca-panel-ping'
export const PANEL_PONG_TYPE = 'orca-panel-pong'
export const PLUGIN_PANEL_FRAME_NAME_PREFIX = 'orca-plugin-panel:'

/** Per-plugin bridge budgets, enforced host-side. */
export const PANEL_MESSAGE_MAX_BYTES = 64 * 1024
export const PANEL_MESSAGE_RATE_LIMIT = { maxMessages: 30, perMs: 10_000 }

/** Size-only liveness lane: count limits let a panel’s pongs exhaust the budget and starve genuine replies.
 * Pongs also spend the data budget, bounding aggregate cost; walks are capped here. */
export const PANEL_CONTROL_MESSAGE_MAX_BYTES = 1024

/** Missed pongs demote panels; busy-loop detection is valid only while the frame-process gate proves isolation from host renderer. */
export const PANEL_WATCHDOG_PING_INTERVAL_MS = 10_000
export const PANEL_WATCHDOG_PONG_TIMEOUT_MS = 5_000

export const panelActionRequestSchema = z.object({
  type: z.literal(PANEL_ACTION_REQUEST_TYPE),
  /** Plugin-chosen correlation id echoed back on the result message. */
  requestId: z.string().min(1).max(128),
  action: z.string().min(1).refine(isPluginPanelAction, 'not a panel-callable action'),
  params: z.unknown().optional()
})

export type PluginPanelActionRequest = z.infer<typeof panelActionRequestSchema>

export const panelPongSchema = z.object({
  type: z.literal(PANEL_PONG_TYPE),
  pingId: z.number().int().nonnegative()
})

export type PluginPanelActionErrorCode =
  | 'invalid_request'
  | 'unknown_method'
  | 'capability_denied'
  | 'consent_required'
  | 'panel_forbidden'
  | 'invalid_params'
  | 'rate_limited'
  | 'unavailable'
  | 'action_failed'

/** Result message posted back into the panel iframe. */
export type PluginPanelActionResultMessage = {
  type: typeof PANEL_ACTION_RESULT_TYPE
  requestId: string
  ok: boolean
  value?: unknown
  errorCode?: PluginPanelActionErrorCode
  error?: string
}

/** Outcome of executing a panel action in main (wire shape of
 *  `plugins:panelAction` / `plugins.panelAction`). */
export type PluginPanelActionOutcome =
  | { ok: true; value: unknown }
  | { ok: false; code: PluginPanelActionErrorCode; error: string }

export const panelSessionTokenSchema = z.string().min(32).max(128)

/** Host-issued opaque sessions identify approved panels; plugin callers never supply their own identity. */
export const panelActionCallSchema = z
  .object({
    sessionToken: panelSessionTokenSchema,
    action: z.string().min(1),
    params: z.unknown().optional()
  })
  .strict()

export type PluginPanelActionCall = z.infer<typeof panelActionCallSchema>

export type PluginPanelEntry = {
  html: string
  sessionToken: string
}

export type PanelActionRequestParseResult =
  | { ok: true; request: PluginPanelActionRequest }
  | { ok: false; requestId: string | null; error: string }

/** On invalid requests, retain a best-effort requestId so the host can return an error instead of silently dropping them. */
export function parsePanelActionRequest(data: unknown): PanelActionRequestParseResult {
  const parsed = panelActionRequestSchema.safeParse(data)
  if (parsed.success) {
    return { ok: true, request: parsed.data }
  }
  let requestId: string | null = null
  if (typeof data === 'object' && data !== null && 'requestId' in data) {
    const raw = (data as { requestId?: unknown }).requestId
    if (typeof raw === 'string' && raw.length > 0 && raw.length <= 128) {
      requestId = raw
    }
  }
  const issue = parsed.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return {
    ok: false,
    requestId,
    error: `${path}: ${issue?.message ?? 'invalid panel action request'}`
  }
}

export function looksLikePanelActionRequest(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === PANEL_ACTION_REQUEST_TYPE
  )
}

/** Mirror panelPongSchema without rejected-parse issue allocations (~90x accepted cost), bounding near-miss spam cost. */
export function readPanelPongId(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const frame = data as { type?: unknown; pingId?: unknown }
  if (frame.type !== PANEL_PONG_TYPE || typeof frame.pingId !== 'number') {
    return null
  }
  // Match Zod’s safe integer domain; broader integers admit ping IDs the watchdog could not issue.
  return Number.isSafeInteger(frame.pingId) && frame.pingId >= 0 ? frame.pingId : null
}
