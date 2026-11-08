import type { NativeChatMessage } from './native-chat-types'
import { isNoiseMessage } from './native-chat-noise'
import { isRootAgentJournalItem } from '../agent-session/journal/agent-session-journal-producer'

export function isConfirmedNativeChatUserSubmission(message: NativeChatMessage): boolean {
  return (
    message.source === 'transcript' &&
    message.role === 'user' &&
    isRootAgentJournalItem(message) &&
    !message.from &&
    !message.command &&
    !message.agentStart &&
    !message.unsent &&
    !message.awaitsRetry &&
    !message.stoppedBeforeStart &&
    !message.pendingSend &&
    !message.deliveryState &&
    !message.sentWhileStopping &&
    !isNoiseMessage(message)
  )
}
