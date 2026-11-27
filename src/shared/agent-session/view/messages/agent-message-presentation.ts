import type {
  AgentMessageSender,
  AgentMessageSource
} from '../../journal/agent-session-message-source'
import type { AgentStatusEntry } from '../../../agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../native-chat/native-chat-types'
import { agentMessageTranscriptText } from './agent-message-display-text'

export function agentMessageIsCompact(
  message: Pick<NativeChatMessage, 'agentStart' | 'from'>
): boolean {
  return message.agentStart === true || message.from?.kind === 'agent'
}

export type AgentMessageHeading =
  | 'started'
  | 'reopened-worker'
  | 'followed-up-worker'
  | 'handed-off'
  | 'started-agent'
  | 'task'
  | 'coordinator'
  | 'worker'
  | 'generic'
export type AgentMessageSenderView = Readonly<{
  agentType?: AgentStatusEntry['agentType']
  progress?: number
  dot?:
    | 'working'
    | 'monitoring'
    | 'blocked'
    | 'waiting'
    | 'interrupted'
    | 'failed'
    | 'done'
    | 'idle'
    | 'unverifiable'
    | 'unconfirmed'
    | 'permission'
}>

/** Takes the message's creation flags and text together, and requires them, so no caller can show a
 *  creation card as a plain message, a handoff as a started worker, or a handoff with no task as work handed over. */
export function agentMessageHeading(
  from: AgentMessageSource,
  creation: Pick<NativeChatMessage, 'agentStart' | 'agentHandoff' | 'agentFollowUp' | 'blocks'>
): AgentMessageHeading {
  if (creation.agentStart) {
    if (!creation.agentHandoff) {
      if (creation.agentFollowUp) {
        return creation.agentFollowUp === 'reopened' ? 'reopened-worker' : 'followed-up-worker'
      }
      return 'started'
    }
    return agentMessageTranscriptText(creation.blocks, from) ? 'handed-off' : 'started-agent'
  }
  if (from.orchestration?.message === 'task') {
    return 'task'
  }
  if (from.orchestration?.message === 'mail-notice' && from.senders.length > 0) {
    if (from.senders.every((sender) => sender.relation === 'coordinator')) {
      return 'coordinator'
    }
    if (from.senders.every((sender) => sender.relation === 'worker')) {
      return 'worker'
    }
  }
  return 'generic'
}

/** A follow-up or a hand-off names who received it; every other heading names who sent it. */
export function agentMessageHeadingNamesRecipient(heading: AgentMessageHeading): boolean {
  return heading === 'followed-up-worker' || heading === 'handed-off'
}

/** A candidate name that names someone; a blank one names no one. */
const nonBlank = (name: string | null | undefined): string | null => (name?.trim() ? name : null)

/** The name the card saved for a sender, when it names someone; a blank one names no one. */
export function agentMessageSavedName(
  sender: Pick<AgentMessageSender, 'name'> | undefined
): string | null {
  return nonBlank(sender?.name)
}

export function resolveAgentMessageSenderName(facts: {
  localChat: boolean
  /** The bot whose home the sender's chat is in; it names every chat there. */
  botName?: string | null
  customLabel?: string | null
  conversationName?: string | null
  snapshotName?: string | null
  tabLabel?: string | null
}): string | null {
  return (
    (facts.localChat &&
      (nonBlank(facts.botName) ||
        nonBlank(facts.customLabel?.trim()) ||
        nonBlank(facts.conversationName))) ||
    nonBlank(facts.snapshotName) ||
    nonBlank(facts.tabLabel?.trim()) ||
    null
  )
}

/** The kind the card saved, when it names one; a saved "unknown" proves nothing, so it is none. */
export function agentMessageSavedKind(
  sender: Pick<AgentMessageSender, 'agent'> | undefined
): AgentMessageSender['agent'] {
  return sender?.agent === 'unknown' ? undefined : sender?.agent
}

/** A Dispatch address names work, not a pane; every other sender address can be opened. */
export function agentMessageSenderCanOpen(sender: AgentMessageSender): boolean {
  return (
    !sender.party.address.startsWith('dispatch:') &&
    !(
      sender.party.address.startsWith('run:') &&
      !sender.party.orcaSessionId &&
      !sender.party.terminalHandle
    )
  )
}

export function agentMessagePrimarySender(
  from: AgentMessageSource
): AgentMessageSender | undefined {
  return from.senders[0]
}

/** The sender's own kind is its icon; a live row adds only its status. */
export function agentMessageSenderView(
  row: AgentMessageSenderView | undefined,
  senderType: AgentMessageSenderView['agentType']
): AgentMessageSenderView {
  if (!row) {
    return { agentType: senderType }
  }
  return senderType === undefined || row.agentType === senderType
    ? row
    : { ...row, agentType: senderType }
}

export function agentMessageCanCopy(text: string): boolean {
  return text.length > 0
}

/** The id Steer and Delete act on while the host still holds this agent message as a queued card;
 *  a handed-off one (its send recorded) is past them. */
export function agentMessageWaitingQueuedId(
  message: Pick<NativeChatMessage, 'queued' | 'queuedMessageId' | 'deliveryState'>
): string | null {
  return message.queued && message.deliveryState === undefined
    ? (message.queuedMessageId ?? null)
    : null
}
