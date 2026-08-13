import type { AgentConsentQueryResult } from './agent-consent'

/**
 * The agent-to-agent message consent gate — pure, Electron-free, deny-by-
 * default. Deliberately mirrors gatePluginHostCall's shape
 * (src/shared/plugins/plugin-capability-gate.ts) closely: a discriminated
 * union result ({ granted: true } | { granted: false, code, error }), and a
 * subject that carries an already-resolved verdict rather than resolving it
 * itself.
 *
 * That last point is the important part to copy faithfully: gatePluginHostCall
 * never looks anything up — it takes `subject.grantedCapabilities`, already
 * computed by its caller, and a null value there (unknown/disabled/stale
 * consent) denies everything. This gate does the same: `subject.decision` is
 * the already-resolved result of AgentConsentStore.query() (see
 * src/main/runtime/agent-consent-store.ts), a single synchronous in-memory
 * lookup performed by the caller (AgentMessageBroker.send() in
 * src/main/runtime/agent-message-broker.ts) *before* calling this function.
 * gateAgentMessageSend itself never touches the store, disk, or the agent
 * registry, so — like gatePluginHostCall — it is unit-testable with nothing
 * but plain data, no mocks, no I/O of any kind.
 */

export type AgentConsentGateErrorCode = 'consent_denied' | 'consent_unknown'

export type AgentConsentGateDecision =
  | { granted: true }
  | { granted: false; code: AgentConsentGateErrorCode; error: string }

export type AgentConsentGateSubject = {
  /** The already-resolved consent verdict for (source agentType, target
   *  agentType) — resolved by the caller via AgentConsentStore.query(). */
  decision: AgentConsentQueryResult
}

export type AgentConsentGateTarget = {
  targetAgentType: string
}

export function gateAgentMessageSend(
  subject: AgentConsentGateSubject,
  target: AgentConsentGateTarget
): AgentConsentGateDecision {
  if (subject.decision === 'allow') {
    return { granted: true }
  }
  if (subject.decision === 'deny') {
    return {
      granted: false,
      code: 'consent_denied',
      error: `messaging agent type "${target.targetAgentType}" was explicitly denied`
    }
  }
  // Why: never-decided defaults to deny — matches gatePluginHostCall's
  // null-grantedCapabilities handling. An agent gains no cross-session
  // messaging reach until a user has actually said yes; there is no
  // "implicitly trusted until refused" state.
  return {
    granted: false,
    code: 'consent_unknown',
    error: `messaging agent type "${target.targetAgentType}" has not been granted consent`
  }
}
