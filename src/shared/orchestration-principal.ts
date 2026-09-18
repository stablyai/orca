import { parsePaneKey } from './stable-pane-id'
import { structuredAgentSessionIdFromTabId } from './structured-agent-session-tab-id'

/** Serialized actor identity persisted on orchestration rows; write-only until the resolver PRs. */
export type OrchestrationPrincipal =
  | { kind: 'pane'; paneKey: string }
  | { kind: 'session'; sessionId: string }

export function formatOrchestrationPrincipal(principal: OrchestrationPrincipal): string {
  return principal.kind === 'pane' ? `pane:${principal.paneKey}` : `session:${principal.sessionId}`
}

/**
 * Split at the FIRST `:` only — pane keys themselves contain a `:`, so the payload is everything
 * after the first colon, verbatim. Unknown tag → null, not throw: a future kind written by a newer
 * binary must degrade, not crash (remote-wire-compatibility posture applied to the DB).
 */
export function parseOrchestrationPrincipal(value: string): OrchestrationPrincipal | null {
  const first = value.indexOf(':')
  if (first <= 0 || first === value.length - 1) {
    return null
  }
  const tag = value.slice(0, first)
  const payload = value.slice(first + 1)
  if (tag === 'pane') {
    return { kind: 'pane', paneKey: payload }
  }
  if (tag === 'session') {
    return { kind: 'session', sessionId: payload }
  }
  return null
}

/**
 * The dual-write/backfill rule: NULL pane key ⇒ NULL principal, and a structured worker's pane key
 * (`structured-agent-session-<sessionId>:<randomUUID>`) classifies to `session:<sessionId>`; any
 * other non-NULL pane key is `pane:<paneKey>`.
 *
 * SECURITY BOUNDARY: deriving a `session:` principal from a pane key is safe here and nowhere
 * else — in the backfill it is a one-time server-side derivation over durable rows the host itself
 * wrote, and at dual-write time it applies only to pane keys the host minted or attested. At
 * REQUEST time the same transformation is a vulnerability: session ids are embedded in tab ids in
 * plain text, so a caller who learns one can fabricate `structured-agent-session-<id>:<anything>`
 * — the random leaf UUID is the only real credential (src/main/runtime/structured-worker-identity.ts).
 * No RPC boundary may ever derive a session principal from a caller-supplied pane key; credentials
 * resolve to principals at the boundary, and the resolver PR owns that request-time invariant. The
 * backfill rule is NOT a general equivalence rule.
 */
export function principalFromPaneKey(paneKey: string | null | undefined): string | null {
  if (!paneKey) {
    return null
  }
  const parsed = parsePaneKey(paneKey)
  const sessionId = parsed ? structuredAgentSessionIdFromTabId(parsed.tabId) : null
  return sessionId
    ? formatOrchestrationPrincipal({ kind: 'session', sessionId })
    : formatOrchestrationPrincipal({ kind: 'pane', paneKey })
}
