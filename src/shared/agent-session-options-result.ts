import type { AgentJournalCursor, AgentJournalThreadGoal } from './agent-session-journal-types'
import type { AgentSessionConversationCommand } from './agent-session/agent-session-conversation-command'
import type { AgentSessionContextUsage } from './agent-session-context-usage'
import type { AgentSessionRewindSupport } from './agent-session-rewind'
import type {
  AgentSessionFastModeState,
  AgentSessionFastModeSupport,
  AgentSessionModelOption
} from './agent-session-wire'

export type AgentSessionAcceptedInputSources = Partial<
  Record<'model' | 'effort' | 'fastMode' | 'serviceTier', 'saved' | 'seeded' | 'policy'>
>

/** Provider-reported choices and effective next-turn values. Additive read-only
 *  surface so older hosts can reject it without changing structured v1 writes. */
export type AgentSessionOptionsResult = {
  rewind?: AgentSessionRewindSupport
  conversationCommands?: readonly AgentSessionConversationCommand[]
  /** Offer goal controls only with threadGoal support; current spans the whole journal, including unloaded pages. */
  threadGoal?: { current: AgentJournalThreadGoal | null; contextFloor?: AgentJournalCursor }
  /** Journal goal changed only by the agent's /goal; separate from threadGoal so older clients never offer host controls. */
  reportedThreadGoal?: { current: AgentJournalThreadGoal; contextFloor?: AgentJournalCursor }
  /** Present for sessions writing turn context facts; current takes each part from the whole journal, including unloaded pages. */
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
    /** Accepted input origins; an empty map excludes all display-only observations. */
    acceptedInputSources?: AgentSessionAcceptedInputSources
    model?: string
    effort?: string
    /** Canonical preference for the next turn. Explicit false is meaningful. */
    fastMode?: boolean
    /** Next-turn service tier id where the model lists `serviceTiers`; `default` is standard. */
    serviceTier?: string
    /** The permission mode a start runs now; absent from a host or agent with no picker. */
    permissionMode?: string
    /** Current startup report or accepted fresh-turn policy: null means reported but not a named Orca mode. */
    reportedPermissionMode?: string | null
    /** Provider-reported effective routing, distinct from the next-turn preference. */
    fastModeState?: AgentSessionFastModeState
    /** Values actually reported by the provider, beyond acceptance alone. Older hosts omit this, preserving unconfirmed values. */
    confirmed?: readonly string[]
    /** Catalog-supplied values, outside chat intent/provider reports; absent from older hosts, whose answers retain their prior interpretation. */
    defaulted?: readonly ('model' | 'effort')[]
  }
}
