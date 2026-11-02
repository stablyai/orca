import { z } from 'zod'
import { isPluginJsonObject } from '../manifest/plugin-json-object'

/**
 * The one wire envelope between Orca and plugin code: worker fork channel, panel frames and custom
 * editor frames. It is internal: frames talk through the shell's `window.orca`, workers through the
 * `orca` object handed to `activate`, so the envelope can change without breaking plugins.
 * Ids are per direction: a `res` answers the other side's `req` with the same id.
 */

export const PLUGIN_PROTOCOL_VERSION = 1

export const PLUGIN_SURFACES = ['worker', 'panel', 'editor'] as const
export type PluginSurface = (typeof PLUGIN_SURFACES)[number]

/** Open set on the wire: a plugin treats a code it does not know as `action_failed`. */
export const PLUGIN_ERROR_CODES = [
  'invalid_request',
  'invalid_params',
  'unknown_method',
  'capability_denied',
  'consent_required',
  'not_permitted',
  'rate_limited',
  'unavailable',
  'action_failed',
  'cancelled',
  'timeout',
  'conflict',
  'too_large'
] as const
export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number]

const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set<PluginErrorCode>([
  'rate_limited',
  'unavailable',
  'timeout',
  'conflict'
])

export type PluginError = {
  code: PluginErrorCode
  message: string
  retryable: boolean
  retryAfterMs?: number
}

export function normalizePluginErrorCode(code: unknown): PluginErrorCode {
  return PLUGIN_ERROR_CODES.find((known) => known === code) ?? 'action_failed'
}

export function pluginError(code: unknown, message: string, retryAfterMs?: number): PluginError {
  const known = normalizePluginErrorCode(code)
  return {
    code: known,
    message: message.slice(0, 8192),
    retryable: RETRYABLE_ERROR_CODES.has(known),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs })
  }
}

/** Main ↔ client wire shape of one host call (`plugins:panelAction` / `plugins.panelAction`). */
export type PluginHostCallOutcome =
  | { ok: true; value: unknown }
  | { ok: false; code: PluginErrorCode; error: string; retryAfterMs?: number }

export function outcomeError(outcome: Extract<PluginHostCallOutcome, { ok: false }>): PluginError {
  return pluginError(outcome.code, outcome.error, outcome.retryAfterMs)
}

const idSchema = z.number().int().nonnegative()
const nameSchema = z.string().min(1).max(128)

export const pluginErrorSchema = z.object({
  code: z.string().max(64),
  message: z.string().max(8192),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().optional()
})

export const pluginEnvelopeSchema = z.discriminatedUnion('kind', [
  z.object({
    orca: z.literal(PLUGIN_PROTOCOL_VERSION),
    kind: z.literal('req'),
    id: idSchema,
    method: nameSchema,
    params: z.unknown().optional()
  }),
  z.object({
    orca: z.literal(PLUGIN_PROTOCOL_VERSION),
    kind: z.literal('res'),
    id: idSchema,
    result: z.unknown().optional(),
    error: pluginErrorSchema.optional()
  }),
  z.object({
    orca: z.literal(PLUGIN_PROTOCOL_VERSION),
    kind: z.literal('evt'),
    event: nameSchema,
    payload: z.unknown().optional()
  }),
  z.object({ orca: z.literal(PLUGIN_PROTOCOL_VERSION), kind: z.literal('cancel'), id: idSchema })
])

export type PluginEnvelope = z.infer<typeof pluginEnvelopeSchema>
export type PluginRequest = Extract<PluginEnvelope, { kind: 'req' }>
export type PluginResponse = Extract<PluginEnvelope, { kind: 'res' }>
export type PluginEvent = Extract<PluginEnvelope, { kind: 'evt' }>

export function readPluginEnvelope(data: unknown): PluginEnvelope | null {
  const parsed = pluginEnvelopeSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

/** Best-effort id of a message refused before parsing, so the sender still gets an answer. */
export function pluginRequestId(data: unknown): number | null {
  return isPluginJsonObject(data) && data.kind === 'req' && Number.isSafeInteger(data.id)
    ? Number(data.id)
    : null
}

export function pluginRequest(id: number, method: string, params?: unknown): PluginRequest {
  return { orca: PLUGIN_PROTOCOL_VERSION, kind: 'req', id, method, params }
}

export function pluginResult(id: number, result: unknown): PluginResponse {
  return { orca: PLUGIN_PROTOCOL_VERSION, kind: 'res', id, result }
}

export function pluginFailure(id: number, error: PluginError): PluginResponse {
  return { orca: PLUGIN_PROTOCOL_VERSION, kind: 'res', id, error }
}

export function pluginOutcomeResponse(id: number, outcome: PluginHostCallOutcome): PluginResponse {
  return outcome.ok ? pluginResult(id, outcome.value) : pluginFailure(id, outcomeError(outcome))
}

export function pluginEvent(event: string, payload?: unknown): PluginEvent {
  return { orca: PLUGIN_PROTOCOL_VERSION, kind: 'evt', event, payload }
}

export function pluginCancel(id: number): Extract<PluginEnvelope, { kind: 'cancel' }> {
  return { orca: PLUGIN_PROTOCOL_VERSION, kind: 'cancel', id }
}
