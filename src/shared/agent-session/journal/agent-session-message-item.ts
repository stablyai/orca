import type { AgentJournalBotMessageFields } from './agent-journal-bot-message-fields'
import type { AgentJournalTypedBy } from './agent-journal-typed-by'
import type { AgentMessageSource } from './agent-session-message-source'
import type { NativeChatBlock, NativeChatRole } from '../../native-chat/native-chat-types'
import type {
  AgentSessionContextUsage,
  AgentSessionTokenUsage
} from '../conversation-context/agent-session-context-usage'
import type {
  AgentJournalMessageSendMode,
  AgentJournalMessageState,
  AgentJournalSkillRef
} from './agent-session-journal-types'

export type AgentJournalMessageItem = {
  usage?: AgentSessionTokenUsage
  usageContext?: AgentSessionContextUsage
  kind: 'message'
  role: NativeChatRole
  blocks: NativeChatBlock[]
  /** Absent ⇒ an ordinary turn input. `goal` ⇒ the text was set as the thread
   * goal's objective, and the provider pursues it without a turn of its own. */
  sentAs?: AgentJournalMessageSendMode
  /** A conversation command and its instructions, kept separate from the person's text. */
  command?: { name: string; instructions?: string }
  skills?: AgentJournalSkillRef[]
  /** Host-written sender and input ownership, never provider content. */
  from?: AgentMessageSource
  typedBy?: AgentJournalTypedBy
  /** Reasoning rows only: absence means unknown, never live. */
  state?: AgentJournalMessageState
  /** Absent for history or crash recovery without an observed end. */
  completedAt?: number
} & AgentJournalBotMessageFields
