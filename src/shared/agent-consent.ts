/**
 * P1-1 Agent-to-Agent Message Consent
 *
 * Types for user consent decisions governing which agents may send messages
 * to which other agents through the P0-2 message broker (see
 * src/shared/agent-message-broker.ts) and the P0-1 identity registry (see
 * src/shared/agent-registry.ts) it addresses by.
 *
 * Granularity: decisions are keyed by (sourceAgentType, targetAgentType) —
 * NOT by keyId, even though keyId is what the broker actually routes
 * messages by. A keyId (LiveAgentInfo.keyId in src/shared/agent-registry.ts)
 * is "derived from SHA256(coordinationKey)" and is documented as unique
 * *per agent session* — it churns every time an agent process restarts.
 * Recording a consent decision against a keyId would mean the grant expires
 * the moment that session ends, so the user would be re-prompted every
 * single launch — the decision would never actually survive long enough to
 * be worth persisting to disk at all.
 *
 * agentType (e.g. "codex", "pi", "prime-agent") is the stable identity that
 * survives restarts, and is exactly the granularity a user reasons about
 * when asked "should Codex sessions be allowed to message Pi sessions?".
 * This mirrors how plugin consent (src/main/plugins/plugin-enablement.ts)
 * keys its record on a plugin's stable qualified key, never on a per-launch
 * process id.
 */

/** A decision that has actually been recorded. Unlike the query result
 *  below, this is never "unknown" — you cannot record "I never decided". */
export type AgentConsentDecision = 'allow' | 'deny'

/**
 * Result of querying the consent store for a (sourceAgentType,
 * targetAgentType) pair. 'unknown' means the pair was never recorded —
 * distinguishing "the user said no" from "the user was never asked".
 * Mirrors gatePluginHostCall's treatment of a null grantedCapabilities set
 * (src/shared/plugins/plugin-capability-gate.ts): both cases must deny,
 * but the gate reports a different, more specific error code for each so a
 * future consent UI can tell "ask the user" apart from "already refused".
 */
export type AgentConsentQueryResult = AgentConsentDecision | 'unknown'

/** A single persisted consent decision. */
export type AgentConsentRecord = {
  /** agentType of the agent that would be sending. */
  sourceAgentType: string

  /** agentType of the agent that would be receiving. */
  targetAgentType: string

  /** The decision itself. */
  decision: AgentConsentDecision

  /** Timestamp (milliseconds since epoch) the decision was recorded. */
  decidedAt: number
}

/** Request to record a consent decision. decidedAt is always assigned by
 *  the store at record time, never caller-supplied — mirrors how
 *  AgentMessage.messageId/timestamp are broker-assigned in
 *  src/shared/agent-message-broker.ts. */
export type AgentConsentRecordRequest = {
  sourceAgentType: string
  targetAgentType: string
  decision: AgentConsentDecision
}

/**
 * Canonical key for a (sourceAgentType, targetAgentType) pair. JSON-encodes
 * the pair as a 2-element array rather than joining with a delimiter (e.g.
 * `${source}::${target}`) so no choice of separator character can ever
 * collide two distinct pairs — `["a", "bc"]` and `["ab", "c"]` serialize
 * differently even though a naive "a::bc" / "ab::c" join would not if an
 * agentType ever contained the delimiter itself.
 */
export function agentConsentPairKey(sourceAgentType: string, targetAgentType: string): string {
  return JSON.stringify([sourceAgentType, targetAgentType])
}
