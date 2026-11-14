import type { AgentSessionRefusalReference } from '../../../../../shared/agent-session/failures/agent-session-wire-refusals'

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

/** A known create failure; the launch classifier keeps uncertain earlier attempts recoverable. */
export class StructuredAgentSessionCreateRefusalError extends StructuredAgentSessionCreateError {
  constructor(
    message: string,
    code: string = 'structured_agent_session_unsupported',
    refusal?: AgentSessionRefusalReference,
    /** The host's own word for why it can't run the chat here (`wsl`, `remote`), when it gave one. */
    readonly hostReason?: string
  ) {
    super(message, code, refusal)
    this.name = 'StructuredAgentSessionCreateRefusalError'
  }
}

/** The source disappeared before any create was sent; no host cancellation is owed. */
export class StructuredAgentSessionCreateAbandonedError extends StructuredAgentSessionCreateRefusalError {}

/** What a source-gated create waits for: true sends it, false abandons it, a refusal fails its chat. */
export type StructuredAgentSessionCreateGate = boolean | StructuredAgentSessionCreateRefusalError

/** The source a create waited on was retired but couldn't hand over; its chat says why in these words. */
export class StructuredAgentSessionCreateSourceFailedError extends StructuredAgentSessionCreateRefusalError {
  constructor(readonly causeText: string) {
    super(causeText)
  }
}

// Refusal without proven absence is ambiguous: sibling creation could duplicate an existing host session. Reconcile/replay it like a lost reply, never classify it as definitive refusal.
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
