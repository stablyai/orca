import {
  agentMessageSenderName,
  orchestrationMailNotice,
  type AgentMessageSender,
  type AgentMessageSource
} from './agent-session-message-source'
import { isOrcaTerminalHandle, parseOrcaSessionAddress } from '../orca-session-address'
import type { AgentStatusEntry } from '../agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../native-chat/native-chat-types'
import { agentMessageTranscriptText } from './agent-message-display-text'

export function agentMessageIsCompact(
  message: Pick<NativeChatMessage, 'agentStart' | 'from'>,
  from = message.from
): boolean {
  return message.agentStart === true || orchestrationMailNotice(from) !== null
}

export const AGENT_MESSAGE_FOLDED_LINES = 3
export type AgentMessageHeading =
  | 'started'
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
  creation: Pick<NativeChatMessage, 'agentStart' | 'agentHandoff' | 'blocks'>
): AgentMessageHeading {
  if (creation.agentStart) {
    if (!creation.agentHandoff) {
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

export function agentMessageSenderLabel(facts: {
  sender?: AgentMessageSender
  localChat: boolean
  customLabel?: string | null
  conversationName?: string | null
  snapshotName?: string | null
  tabLabel?: string | null
  fallback: string
}): string {
  if (agentMessageSenderIsNamedSource(facts.sender)) {
    return facts.snapshotName || agentMessageSenderName(facts.sender?.party.address) || '—'
  }
  return (
    (facts.localChat && (facts.customLabel?.trim() || facts.conversationName)) ||
    facts.snapshotName ||
    facts.tabLabel?.trim() ||
    facts.fallback
  )
}

/** The kind the card saved, when it names one; a saved "unknown" proves nothing, so it is none. */
export function agentMessageSavedKind(
  sender: Pick<AgentMessageSender, 'agent'> | undefined
): AgentMessageSender['agent'] {
  return sender?.agent === 'unknown' ? undefined : sender?.agent
}

/** Arbitrary CLI sender names are sources, not terminal identities; missing live rows prove nothing. */
export function agentMessageSenderIsNamedSource(sender: AgentMessageSender | undefined): boolean {
  return Boolean(
    sender &&
    !sender.party.orcaSessionId &&
    !parseOrcaSessionAddress(sender.party.address) &&
    !agentMessageSavedKind(sender) &&
    !sender.party.address.startsWith('dispatch:') &&
    !isOrcaTerminalHandle(sender.party.address) &&
    !isOrcaTerminalHandle(sender.party.terminalHandle)
  )
}

/** Named sources and Dispatch addresses have no sender pane to open. */
export function agentMessageSenderCanOpen(sender: AgentMessageSender): boolean {
  return !sender.party.address.startsWith('dispatch:') && !agentMessageSenderIsNamedSource(sender)
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

export function agentMessageOverflows(height: number, lineHeight: number): boolean {
  return height > lineHeight * AGENT_MESSAGE_FOLDED_LINES + 1
}

export function agentMessageFoldLabel(open: boolean): 'expanded' | 'collapsed' {
  return open ? 'expanded' : 'collapsed'
}

export function agentMessageCanCopy(text: string): boolean {
  return text.length > 0
}
