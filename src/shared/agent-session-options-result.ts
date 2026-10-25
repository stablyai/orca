import type { AgentJournalCursor, AgentJournalThreadGoal } from './agent-session-journal-types'
import type { AgentSessionConversationCommand } from './agent-session/agent-session-conversation-command'
import type { AgentSessionContextUsage } from './agent-session-context-usage'
import type { AgentSessionRewindSupport } from './agent-session-rewind'
import type {
  AgentSessionFastModeState,
  AgentSessionFastModeSupport,
  AgentSessionModelOption
} from './agent-session-wire'

/** Provider-reported choices and effective next-turn values. Additive read-only
 *  surface so older hosts can reject it without changing structured v1 writes. */
export type AgentSessionOptionsResult = {
  rewind?: AgentSessionRewindSupport
  conversationCommands?: readonly AgentSessionConversationCommand[]
  /** Present only where this session can change its goal, so a host without
   *  `agentSession.threadGoal` never offers the controls. `current` is the
   *  latest goal the whole journal records, for a client whose loaded page
   *  starts after it. */
  threadGoal?: { current: AgentJournalThreadGoal | null; contextFloor?: AgentJournalCursor }
  /** The goal a session's journal records where only the agent's own `/goal` command changes it.
   *  Separate from `threadGoal`, so a client that predates it never offers host controls. */
  reportedThreadGoal?: { current: AgentJournalThreadGoal; contextFloor?: AgentJournalCursor }
  /** Present only where this session writes context facts to its turn rows.
   *  `current` is the newest of each part the whole journal records, for a
   *  client whose loaded page starts after the row that carries it. */
  contextUsage?: { current: AgentSessionContextUsage; contextFloor?: AgentJournalCursor }
  /** This session takes image attachments. Absent = unknown (an older host). */
  acceptsImages?: boolean
  models: AgentSessionModelOption[]
  /** The `models` ids the agent's own finished listing names, excluding host-added rows and
   *  unverified launch-only rows. Absent: nothing verified, as from an older host. */
  listedModelIds?: string[]
  /** Session/account/transport support. Absent means unknown, never unsupported. */
  fastModeSupport?: AgentSessionFastModeSupport
  current: {
    model?: string
    effort?: string
    /** Canonical preference for the next turn. Explicit false is meaningful. */
    fastMode?: boolean
    /** Next-turn service tier id where the model lists `serviceTiers`; `default` is standard. */
    serviceTier?: string
    /** The permission mode a start runs now; absent from a host or agent with no picker. */
    permissionMode?: string
    /** Provider-reported effective routing, distinct from the next-turn preference. */
    fastModeState?: AgentSessionFastModeState
    /**
     * Option ids whose value the provider reported back, not merely accepted.
     * Optional: a host that predates it sends nothing and the client keeps
     * treating the value as unconfirmed, which is what it was before.
     */
    confirmed?: readonly string[]
    /** Values a catalog default supplied, not the chat's intent or its provider's report. Absent
     *  from an older host, whose answer a client reads as it always has. */
    defaulted?: readonly ('model' | 'effort')[]
  }
}
