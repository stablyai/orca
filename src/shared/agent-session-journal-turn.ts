import type {
  AgentJournalItemIdentity,
  AgentJournalTurn,
  AgentJournalItemBody
} from './agent-session-journal-types'

export function agentJournalIdentityTurn(
  identity: AgentJournalItemIdentity,
  body?: AgentJournalItemBody
): AgentJournalTurn | undefined {
  return (
    identity.turn ??
    (identity.provider === 'codex'
      ? { turnId: identity.turnId, ...(identity.ordinal === 0 ? { root: true as const } : {}) }
      : body?.kind === 'status' && body.turnLifecycle
        ? { turnId: body.turnLifecycle.turnId }
        : undefined)
  )
}
