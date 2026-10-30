import type { AgentType } from './agent-status-types'
import type { AgentSessionProviderHandle } from './agent-session-provider-handle'

/** Epoch-qualified position in one journal. `sequence` 0 means "before the first row". */
export type AgentJournalCursor = {
  epoch: string
  sequence: number
}

/** Persisted/wire handles must retain their shape; attach omits opaque. Derived via agentSessionJournalProviderHandle; opaque covers other transports or pending proof. */
export type AgentSessionJournalProviderHandle =
  | { kind: 'codex'; threadId: string }
  | { kind: 'claude'; sessionId: string; leafUuid: string | null }
  | { kind: 'opaque'; agent: AgentType; value: string }

/** The narrow slice of the durable session record the journal needs. The full
 *  record (owner, lease, account home) belongs to the session store. */
export type AgentSessionJournalIdentity = {
  /** Orca agent-session id — the journal's primary key. */
  sessionId: string
  /** Execution-host workspace key. Identical for a worktree, a folder
   *  workspace, a WSL distro, and an SSH host; never a path. */
  workspaceId: string
  /** Execution host that owns the process, so a client restart adjudicates nothing. */
  hostId: string
  agent: AgentType
  /** The record's proved handle; null before the provider has proved one. */
  providerHandle: AgentSessionProviderHandle | null
}

// Codex renumbers items on resume, so persisted item IDs are not identity; Claude preserves UUIDs on fork.

export type AgentJournalItemIdentity =
  | { provider: 'codex'; threadId: string; turnId: string; ordinal: number }
  | { provider: 'claude'; sessionId: string; uuid: string }
  /** A submission Orca minted before any provider echo existed. */
  | { provider: 'orca'; clientMessageId: string }
  /** Bridge-era transcript record with no provider-stable identity. */
  | { provider: 'legacy'; agent: AgentType; sessionId: string; recordId: string }
