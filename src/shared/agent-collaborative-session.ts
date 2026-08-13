/**
 * P2-1 Collaborative Session Tracking
 *
 * Types for tracking a *logical grouping of agent participants* engaged in a
 * cross-session conversation — e.g. "Codex session X and Pi session Y are
 * currently collaborating." This sits above the P0-1 identity registry (see
 * src/shared/agent-registry.ts) and the P0-2 message broker (see
 * src/shared/agent-message-broker.ts): a session groups keyIds the registry
 * already knows about, but does not replace either of those.
 *
 * Naming note — deliberately NOT called "AgentSession": that name is already
 * taken in this codebase for something unrelated. `RuntimeEnsureAgentSessionRequest`
 * / `terminal.ensureAgentSession` (src/main/runtime/orca-runtime.ts,
 * src/main/runtime/rpc/methods/agent-session.ts) refer to a single PTY-backed
 * TUI agent process — one running Codex/Pi/etc. instance in a terminal. A
 * "CollaborativeSession" here is a different concept one layer up: a group
 * of *already-registered* agent keyIds (each of which may itself be backed
 * by one of those PTY "agent sessions") that a caller has decided are
 * participating in the same cross-agent conversation. Conflating the two
 * names would make every future grep for "agent session" ambiguous, so this
 * type is called CollaborativeSession throughout, and its RPC methods live
 * under the 'agent.collabSession.*' namespace rather than 'agent.session.*'.
 *
 * Also NOT the same as the UI-layer "session tabs" concept
 * (src/main/runtime/rpc/methods/session-tabs.ts, 'session.tabs.*' RPC
 * namespace, src/renderer/src/runtime/web-session-tabs-sync.ts). Session
 * tabs are per-worktree terminal/pane UI state — tab order, pane layout,
 * which leaf is active, markdown-vs-terminal tab kind — entirely a renderer
 * presentation concern with no notion of "agent keyId" or cross-session
 * messaging at all (grepped: session-tabs-schemas.ts has no keyId/agentType
 * field anywhere). A CollaborativeSession has no pane, no tab order, no
 * worktree-scoped UI state, and is never rendered as a tab. The two concepts
 * happen to share the English word "session"; nothing else. See
 * CollaborativeSessionTracker in src/main/runtime/agent-collaborative-session.ts
 * for the fuller design note on why this is a new, independent type rather
 * than an extension of session-tabs.
 *
 * Persistence: in-memory only, like the P0-1 registry and P0-2 broker — see
 * the design note at the top of src/main/runtime/agent-collaborative-session.ts
 * for why this phase does not add disk persistence either.
 */

/**
 * A logical grouping of registered agent keyIds participating in the same
 * cross-session conversation.
 */
export type CollaborativeSession = {
  /**
   * Unique identifier for this session, assigned by the tracker at creation
   * time (never caller-supplied) — mirrors AgentMessage.messageId being
   * broker-assigned in src/shared/agent-message-broker.ts, so every session
   * carries a trustworthy id regardless of which RPC caller requested it.
   */
  sessionId: string

  /**
   * keyIds (see src/shared/agent-registry.ts's LiveAgentInfo.keyId) of the
   * agents participating in this session. Order is insertion order;
   * duplicates are never stored (adding an already-present keyId is a
   * no-op, not an error — see CollaborativeSessionTracker.addParticipant).
   *
   * Deliberately keyId, not agentType: a session tracks *which running
   * agent instances* are in a given conversation ("this specific Codex
   * process and this specific Pi process are talking"), not which agent
   * types are allowed to talk at all (that's P1-1's consent store, keyed by
   * agentType — see src/shared/agent-consent.ts for why that's a different,
   * coarser granularity on purpose).
   */
  participantKeyIds: string[]

  /**
   * Timestamp (milliseconds since epoch) when the session was created.
   * Never updated after creation.
   */
  createdAt: number

  /**
   * Timestamp (milliseconds since epoch) of the most recent tracked
   * activity on this session — bumped by touch() and by addParticipant().
   * Unlike LiveAgentInfo.lastActivityAt (src/shared/agent-registry.ts),
   * this is NOT used for any TTL/expiration — see the design note in
   * src/main/runtime/agent-collaborative-session.ts for why a
   * CollaborativeSession does not expire the way a registry entry does.
   * It exists purely as descriptive metadata (e.g. for a future "sort
   * sessions by recency" UI), not as a liveness signal anything currently
   * reads to make a decision.
   */
  lastActivityAt: number

  /**
   * Optional caller-supplied metadata about the session. Mirrors
   * LiveAgentInfo.metadata's shape and intent exactly: an open bag for
   * context a future phase might want (e.g. a worktreeId, a human-readable
   * label) without this phase having to commit to a concrete schema for it.
   * Nothing in this phase writes or reads a specific key out of it.
   *
   * On a worktreeId specifically: this bag is where one *would* eventually
   * land if a future phase wired worktree identity through, but nothing
   * does so today, and this phase deliberately does not key P1-1 consent
   * off of it either — see the "Verdict: P1-1 consent stays agentType-scoped,
   * NOT worktree-scoped" design note in
   * src/main/runtime/agent-collaborative-session.ts for the full reasoning
   * (short version: there is no live registration call site that populates
   * a worktreeId anywhere in this stack yet, so there is nothing to scope
   * against).
   */
  metadata?: Record<string, unknown>
}

/**
 * Request to create a new collaborative session.
 */
export type CollaborativeSessionCreateRequest = {
  /**
   * Initial participant keyIds. Must contain at least
   * COLLABORATIVE_SESSION_CONFIG.MIN_PARTICIPANTS entries once deduplicated,
   * and no more than MAX_PARTICIPANTS_PER_SESSION.
   */
  participantKeyIds: string[]

  /**
   * Optional metadata to attach at creation time.
   */
  metadata?: Record<string, unknown>
}

/**
 * Options for listing/querying sessions.
 */
export type CollaborativeSessionListOptions = {
  /**
   * Only return sessions that include this keyId as a participant.
   */
  participantKeyId?: string
}

/**
 * Result of a session list query.
 */
export type CollaborativeSessionListResult = {
  /**
   * The sessions matching the query criteria.
   */
  sessions: CollaborativeSession[]

  /**
   * Total number of sessions currently tracked (before filtering).
   */
  totalCount: number
}

/**
 * Bounds for the collaborative session tracker, mirroring
 * AGENT_REGISTRY_CONFIG / AGENT_MESSAGE_BROKER_CONFIG's role for their
 * respective modules.
 */
export const COLLABORATIVE_SESSION_CONFIG = {
  /**
   * Minimum number of (deduplicated) participants a session must be created
   * with. A "grouping of participating agents" with zero participants is
   * not a session at all.
   */
  MIN_PARTICIPANTS: 1,

  /**
   * Maximum number of participants a single session may ever hold. Guards
   * against a runaway caller growing one session without bound — mirrors
   * MAX_LISTENERS_PER_KEY's role in src/shared/agent-message-broker.ts.
   */
  MAX_PARTICIPANTS_PER_SESSION: 32
} as const
