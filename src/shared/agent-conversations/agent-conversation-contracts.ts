import {
  AGENT_STATUS_STATES,
  type AgentStatusState
} from '../agent-status/contracts/agent-status-types'
import type { RuntimeListingHostScope } from '../runtime-listing-host-scope'

export type AgentConversationKind = 'chat' | 'terminal'

/** A listed agent's state: its live status, or `asleep` for a terminal agent with no open pane
 *  whose saved record Orca keeps (its workspace asleep, or its tab not reopened since a wake). */
export const AGENT_LIST_STATES = [...AGENT_STATUS_STATES, 'asleep'] as const
export type AgentListState = AgentStatusState | 'asleep'

/** One agent, chat or terminal, as `orca agent list` shows it. */
export type AgentConversationRow = {
  /** The conversation's Orca session ID (a chat's /clear root); null for a terminal agent the
   *  host has not named yet, which no command can address by ID. */
  orcaSessionId: string | null
  kind: AgentConversationKind
  agent: string | null
  state: AgentListState
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
  /** Where it is open now: none when it isn't open, two for one conversation resumed in two panes;
   *  a terminal agent with no open pane shows its saved `asleep` place. Read from the
   *  conversation's own status rows, so open places carry no title (`list` does). */
  places: AgentConversationRow[]
}

export type AgentReadTool = { name: string; state?: string }

/** Every entry may say `shortened`: its text was cut to fit one reply; the app keeps it whole. */
export type AgentReadEntry = AgentReadEntryBody & { shortened?: true }

type AgentReadEntryBody =
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
  noTranscript: 'agent_no_transcript'
} as const
