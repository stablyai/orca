import type { BotChatIdentity } from '../bots/use-bot-chat-identity'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../shared/agent-session/view/structured-agent-session-message-projection'
import type { StructuredAgentSessionReadOwner } from './session/structured/read/structured-agent-session-read-owner-contract'
import type { NativeChatLiveSession } from './session/terminal/read/native-chat-live-session-contract'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { NativeChatTurnActivity } from '../../../../shared/native-chat/transcript/turns/native-chat-turn-activity'
import type { StructuredAgentSessionHostWork } from './session/structured/use-structured-agent-session-transport-state'
import type { NativeChatDeliveryNotice } from './messages/rows/NativeChatMessageRow'
import type { NativeChatTimedRow } from './conversation/slots/native-chat-timed-rows'
import type { NativeChatSubagentView } from './subagents/native-chat-open-subagent'
import type { StructuredAgentSubagentRoster } from '../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import type { NativeChatRailOutlineEntry } from './viewport/rail/native-chat-message-rail-items'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSubmission } from '../../../../shared/agent-session/view/structured-agent-session-submissions'
import type { AgentSessionLatestTurn } from '../../../../shared/agent-session/agent-session-wire'
import type { NativeChatSettledTurns } from '../../../../shared/native-chat/transcript/turns/native-chat-turn-status'
import type { NativeChatAwaitingInput } from '../../../../shared/native-chat/transcript/turns/native-chat-terminal-turn'
import type { NativeChatBotKickoffView } from './native-chat-bot-kickoff-view'
import type { useNativeChatMessageListHandle } from './messages/actions/use-native-chat-reveal-latest'

export type NativeChatMessageListProps = {
  turnBot?: BotChatIdentity | null
  ref?: Parameters<typeof useNativeChatMessageListHandle>[0]
  session: NativeChatLiveSession
  structuredAttachments?: boolean
  journalItems?: readonly AgentJournalRenderItem[]
  /** With the items, what places each row in its turn (structured lane). */
  journalSubmissions?: readonly StructuredAgentSubmission[]
  /** The host's newest turn record, which places a live turn whose record is not loaded. */
  journalLatestTurn?: AgentSessionLatestTurn | null
  /** The host's prompts still waiting on the person and its working answer (an older host: none). */
  journalHostWork?: StructuredAgentSessionHostWork
  /** Every subagent the session's rosters named, whether or not its roster row is loaded. */
  subagentRoster?: StructuredAgentSubagentRoster
  /** The subagent shown in place of the conversation (its own rows, no turns), and how to open one. */
  subagentView?: NativeChatSubagentView
  /** User messages older than the loaded window, from the host's outline. */
  railOutline?: readonly NativeChatRailOutlineEntry[] | null
  isVisible?: boolean
  isWorking: boolean
  /** Toolbar-driven desired open state for every tool run; each flip re-syncs. */
  expandSignal: boolean
  workingStartedAt?: number | null
  /** Host durations by prompt id; otherwise fall back to a duration observed locally. */
  settledTurns?: NativeChatSettledTurns
  deliveryNotices?: ReadonlyMap<string, NativeChatDeliveryNotice>
  sendingPending?: readonly StructuredAgentSessionOptimisticMessage[]
  deliveryReadOwner?: StructuredAgentSessionReadOwner
  /** Rows that are not part of the conversation but happened during it, such as workers' approvals. */
  timedRows?: readonly NativeChatTimedRow[]
  /** Set while the turn waits on the reader; the live activity line yields to it. */
  awaitingInput?: NativeChatAwaitingInput | null
  turnActivity?: NativeChatTurnActivity | null
  /** A person's Stop is ending the live turn: its tail line reads "Stopping…". */
  stopping?: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
  /** A bot Chat's kickoff view, and a new bot's first screen over the transcript. */
  botHome?: NativeChatBotKickoffView
}
