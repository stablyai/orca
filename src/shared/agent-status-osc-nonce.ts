/**
 * Pane-bound nonce for the OSC 9999 agent-status channel.
 *
 * What the nonce proves: the emitter could read the pane's environment, i.e. it
 * is the pane's own process or a descendant of it. It does NOT prove the
 * emitter is an agent, and it does NOT stop code already running inside the
 * pane from reading the value and forging a payload. It exists to stop text
 * that merely *passes through* the pane (a fetched page, a cat'd log, relayed
 * output from another agent) from asserting agent status for that pane.
 */

/** Injected into pane env next to ORCA_PANE_KEY, so descendants inherit it. */
export const AGENT_STATUS_OSC_NONCE_ENV_VAR = 'ORCA_AGENT_STATUS_NONCE'

/** Payload field carrying the nonce. Additive: older parsers drop unknown keys. */
export const AGENT_STATUS_OSC_NONCE_FIELD = 'nonce'

/** Bound before any comparison so an oversized JSON string can't be used as a work amplifier. */
export const AGENT_STATUS_OSC_NONCE_MAX_LENGTH = 128

/** Bytes of entropy per pane. 128 bits is unguessable and keeps the payload short. */
export const AGENT_STATUS_OSC_NONCE_BYTES = 16

export type AgentStatusOscTrust =
  /** Nonce present and matched the pane's. */
  | 'pane-verified'
  /** Pane carries a nonce, payload omitted it — a pre-nonce integration, or injected text. */
  | 'pane-unattested'
  /** Pane was never stamped (older host, pre-feature PTY), so no nonce could be expected. */
  | 'pane-unstamped'

export type AgentStatusOscNonceEnforcement =
  /** Accept unattested payloads, record the tier. Wrong nonces are still dropped. */
  | 'observe'
  /** Additionally drop unattested payloads in stamped panes. */
  | 'enforce'

/**
 * Ships as `observe`: OSC 9999 is an undocumented surface every one of whose
 * payloads today comes from an external process (nothing in this repo emits
 * it), so a hard cutover would silently break integrations we cannot enumerate.
 * See docs/reference/agent-status-osc-nonce.md for the flip criteria.
 */
export const DEFAULT_AGENT_STATUS_OSC_NONCE_ENFORCEMENT: AgentStatusOscNonceEnforcement = 'observe'

export type AgentStatusOscNonceVerdict = {
  trust: AgentStatusOscTrust
  accepted: boolean
}

export function isWellFormedAgentStatusOscNonce(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= AGENT_STATUS_OSC_NONCE_MAX_LENGTH
  )
}

/** Length-first, then full-width compare: no early exit on the first differing char. */
function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Grade one OSC 9999 payload against the pane's nonce.
 *
 * A *wrong* nonce is dropped in every mode: no integration sends one today, so
 * the only sources are a replayed capture from another pane and a forgery.
 */
export function gradeAgentStatusOscNonce(args: {
  presented: unknown
  expected: string | null | undefined
  enforcement: AgentStatusOscNonceEnforcement
}): AgentStatusOscNonceVerdict {
  const expected = isWellFormedAgentStatusOscNonce(args.expected) ? args.expected : null
  if (!expected) {
    return { trust: 'pane-unstamped', accepted: true }
  }
  if (args.presented === undefined || args.presented === null) {
    return { trust: 'pane-unattested', accepted: args.enforcement !== 'enforce' }
  }
  if (!isWellFormedAgentStatusOscNonce(args.presented)) {
    return { trust: 'pane-unattested', accepted: false }
  }
  if (constantTimeEquals(args.presented, expected)) {
    return { trust: 'pane-verified', accepted: true }
  }
  return { trust: 'pane-unattested', accepted: false }
}

/** Read the enforcement mode from an env bag (main resolves it from process.env). */
export function resolveAgentStatusOscNonceEnforcement(
  raw: string | undefined
): AgentStatusOscNonceEnforcement {
  const normalized = raw?.trim().toLowerCase()
  if (normalized === 'enforce' || normalized === 'observe') {
    return normalized
  }
  return DEFAULT_AGENT_STATUS_OSC_NONCE_ENFORCEMENT
}
