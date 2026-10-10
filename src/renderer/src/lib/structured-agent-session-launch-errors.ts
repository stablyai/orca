import type { AgentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'

export class StructuredAgentSessionCreateError extends Error {
  constructor(
    message: string,
    /** The wire refusal code, or the RPC error code when the create never reached a handler. */
    readonly code: string,
    /** The host's refusal as a reader may word it; absent from an older host or a local failure. */
    readonly refusal?: AgentSessionRefusalReference
  ) {
    super(message)
  }
}

/**
 * The host proved it created nothing. The class itself is the verdict:
 * `launchStructuredAgentSession` is the only place that decides it against the shared allowlist.
 */
export class StructuredAgentSessionCreateRefusalError extends StructuredAgentSessionCreateError {
  constructor(
    message: string,
    code: string = 'structured_agent_session_unsupported',
    refusal?: AgentSessionRefusalReference
  ) {
    super(message, code, refusal)
    this.name = 'StructuredAgentSessionCreateRefusalError'
  }
}

/**
 * Refused with a code that does not prove the session is absent. A sibling opened here would sit
 * beside a session the host may already hold, so this deliberately is NOT a refusal error: it flows
 * down the same path as a lost reply, which replays the intent and reconciles.
 */
export class StructuredAgentSessionCreateUnknownOutcomeError extends StructuredAgentSessionCreateError {
  constructor(message: string, code: string, refusal?: AgentSessionRefusalReference) {
    super(message, code, refusal)
    this.name = 'StructuredAgentSessionCreateUnknownOutcomeError'
  }
}

/** Orca cannot name the one host that owns the workspace, so no chat is started anywhere. */
export class StructuredAgentSessionOwnerUnresolvedError extends Error {
  constructor(worktreeId: string) {
    super(`No single runtime owns workspace ${worktreeId}`)
    this.name = 'StructuredAgentSessionOwnerUnresolvedError'
  }
}
