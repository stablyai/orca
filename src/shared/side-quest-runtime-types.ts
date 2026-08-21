import type { NativeChatMessage } from './native-chat-types'

export type SideQuestCreateArgs = {
  cwd: string
}

export type SideQuestCreateResult = {
  providerThreadId: string
}

export type SideQuestReadArgs = {
  providerThreadId: string
}

export type SideQuestReadResult = {
  messages: NativeChatMessage[]
}

export type SideQuestSendArgs = {
  providerThreadId: string
  text: string
  clientUserMessageId: string
}

export type SideQuestSendResult = {
  turnId: string
}

export type SideQuestInterruptArgs = {
  providerThreadId: string
  turnId: string
}

export type SideQuestSubscribeArgs = {
  subscriptionId: string
  providerThreadId: string
}

export type SideQuestStreamEvent =
  | {
      type: 'agent-message-delta'
      providerThreadId: string
      turnId: string
      itemId: string
      delta: string
    }
  | {
      type: 'message-completed'
      providerThreadId: string
      turnId: string
      message: NativeChatMessage
    }
  | {
      type: 'turn-completed'
      providerThreadId: string
      turnId: string
      status: string
      error: string | null
    }
  | {
      type: 'error'
      providerThreadId: string
      message: string
    }

export type SideQuestStreamPayload = {
  subscriptionId: string
  event: SideQuestStreamEvent
}
