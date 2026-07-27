import { z } from 'zod'
import { getPluginHostMethodSpec, isPluginPanelAction } from './plugin-host-api'

/**
 * postMessage protocol between a sandboxed plugin panel iframe and the host
 * renderer, plus the action call shape relayed to main. The frame has an
 * opaque origin (sandbox="allow-scripts"), so neither side can use origins
 * for trust: the host verifies the sending window's identity and re-validates
 * every payload here; main re-checks capabilities before executing.
 *
 * Param/result schemas come from the host API v0 spec table — the panel
 * bridge is a transport, not a second contract.
 */

export const PANEL_ACTION_REQUEST_TYPE = 'orca-panel-action'
export const PANEL_ACTION_RESULT_TYPE = 'orca-panel-action-result'
export const PANEL_PING_TYPE = 'orca-panel-ping'
export const PANEL_PONG_TYPE = 'orca-panel-pong'
export const PLUGIN_PANEL_FRAME_NAME_PREFIX = 'orca-plugin-panel:'

/** Per-plugin bridge budgets, enforced host-side. */
export const PANEL_MESSAGE_MAX_BYTES = 64 * 1024
export const PANEL_MESSAGE_RATE_LIMIT = { maxMessages: 30, perMs: 10_000 }

/** Watchdog cadence: a panel that misses a pong deadline is demoted to an
 *  errored badge. Busy-loop detection is valid only while the runtime frame-
 *  process gate confirms the sandbox stays outside the host renderer. */
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

/** Call shape relayed by a trusted panel host. The opaque session is issued
 *  while loading one approved panel, so the caller never supplies identity. */
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

/** Validates a raw `message` event payload from the panel iframe. On failure
 *  still surfaces a best-effort requestId so the host can answer with an
 *  error instead of silently dropping the request. */
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

/** True when `data` even looks like a bridge request (right `type`). Used to
 *  ignore unrelated window messages without replying to them. */
export function looksLikePanelActionRequest(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === PANEL_ACTION_REQUEST_TYPE
  )
}

export function looksLikePanelPong(data: unknown): boolean {
  return panelPongSchema.safeParse(data).success
}

/** Validates action params against the host API spec (shared with workers). */
export function parsePanelActionParams(
  action: string,
  params: unknown
): { ok: true; params: unknown } | { ok: false; error: string } {
  const spec = getPluginHostMethodSpec(action)
  if (!spec) {
    return { ok: false, error: `unknown action: ${action}` }
  }
  const parsed = spec.params.safeParse(params)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join('.') || '(root)'
    return { ok: false, error: `${path}: ${issue?.message ?? 'invalid action params'}` }
  }
  return { ok: true, params: parsed.data }
}
