import {
  AGENT_STATUS_JSON_STRUCTURE_LIMITS,
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from './agent-status-types'
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import { AGENT_STATUS_OSC_NONCE_FIELD } from './agent-status-osc-nonce'

export type AgentStatusOscFrame = {
  payload: ParsedAgentStatusPayload
  /** Raw, unvalidated — only the gate reads it, and only to compare. */
  nonce: unknown
}

/**
 * Parse an OSC 9999 frame, surfacing its pane nonce separately from the status
 * fields.
 *
 * Why separate: the nonce is a pane secret and `ParsedAgentStatusPayload` is
 * persisted to last-status.json and republished to every paired client. Keeping
 * it off the payload type means no consumer can leak it by accident — the
 * normalizer builds an explicit object, so the field is dropped structurally
 * rather than by a filter someone has to remember.
 */
export function parseAgentStatusOscFrame(json: string): AgentStatusOscFrame | null {
  try {
    assertJsonTextStructureWithinLimits(json, AGENT_STATUS_JSON_STRUCTURE_LIMITS)
    const parsed: unknown = JSON.parse(json)
    const payload = normalizeAgentStatusPayload(parsed)
    if (!payload) {
      return null
    }
    const nonce =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)[AGENT_STATUS_OSC_NONCE_FIELD]
        : undefined
    return { payload, nonce }
  } catch {
    return null
  }
}
