import type { AgentStatusState } from '../agent-status/contracts/agent-status-types'
import type { RuntimeListingHostScope } from '../runtime-listing-host-scope'

export type AgentConversationKind = 'chat' | 'terminal'

/** One open agent, chat or terminal, as `orca agent list` shows it. */
export type AgentConversationRow = {
  /** The conversation's Orca session ID (a chat's /clear root); null for a terminal agent the
   *  host has not named yet, which no command can address by ID. */
  orcaSessionId: string | null
  kind: AgentConversationKind
  agent: string | null
  state: AgentStatusState
  worktreeId: string
  workspace: string
  /** The workspace's project, so two workspaces on one branch name tell apart. */
  repo?: string
  hostId?: string
  paneKey: string
  title: string | null
  lastAssistantMessage: string | null
  updatedAt: number
}

export type AgentListResult = {
  agents: AgentConversationRow[]
  truncated: boolean
  /** The hosts this listing covered and those it did not; absent from hosts that predate it. */
  hostScope?: RuntimeListingHostScope
}

export type AgentShowResult = {
  orcaSessionId: string
  kind: AgentConversationKind
  /** Where it is open now: none when it isn't open, two for one conversation resumed in two panes.
   *  Read from the conversation's own status rows, so they carry no title (`list` does). */
  places: AgentConversationRow[]
}

export type AgentReadTool = { name: string; state?: string }

export type AgentReadEntry =
  /** `tools`: the tool calls a transcript message made, folded into its one entry. */
  | { kind: 'message'; role: string; text: string; tools?: AgentReadTool[] }
  | ({ kind: 'tool' } & AgentReadTool)
  | { kind: 'approval' | 'question'; text: string; pending: boolean }
  | { kind: 'error'; text: string }

export type AgentReadResult = {
  orcaSessionId: string
  kind: AgentConversationKind
  agent: string | null
  /** `chat`: the chat's own history; `transcript`: the terminal agent's transcript file. */
  source: 'chat' | 'transcript'
  entries: AgentReadEntry[]
  /** Pass back as `cursor` to read only what came after this page; tied to this source. */
  cursor: string | null
  /** Older entries exist that this page did not include. */
  limited: boolean
}

export const AGENT_READ_DEFAULT_LIMIT = 20
export const AGENT_READ_MAX_LIMIT = 100

/** Codes `orca agent` refusals carry in `--json`; the message says what to do. */
export const AGENT_CONVERSATION_REFUSAL_CODES = {
  unknown: 'agent_unknown',
  providerId: 'agent_provider_id',
  terminalHandle: 'agent_terminal_handle',
  invalidId: 'agent_invalid_id',
  unavailable: 'agent_unavailable',
  noTranscript: 'agent_no_transcript',
  sourceChanged: 'agent_read_source_changed',
  invalidCursor: 'agent_read_cursor_invalid'
} as const
