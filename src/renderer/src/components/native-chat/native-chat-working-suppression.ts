import type { NativeChatMessage } from '../../../../shared/native-chat-types'

const NATIVE_CHAT_HOOK_TRANSCRIPT_SKEW_MS = 5_000

export function nativeChatHookTurnCompletedByTranscript(
  messages: readonly NativeChatMessage[],
  workingStartedAt: number
): boolean {
  let latestUserAt = -1
  let latestAssistantAt = -1
  const userTurnFloor = workingStartedAt - NATIVE_CHAT_HOOK_TRANSCRIPT_SKEW_MS

  for (const message of messages) {
    if (message.timestamp === null) {
      continue
    }
    if (message.role === 'user' && message.timestamp >= userTurnFloor) {
      latestUserAt = Math.max(latestUserAt, message.timestamp)
    } else if (message.role === 'assistant' && message.timestamp >= workingStartedAt) {
      latestAssistantAt = Math.max(latestAssistantAt, message.timestamp)
    }
  }

  return latestUserAt >= userTurnFloor && latestAssistantAt >= latestUserAt
}

export function shouldShowNativeChatWorking(args: {
  isConversation: boolean
  viewWorking: boolean
  hookWorking: boolean
  hookTurnCompletedByTranscript?: boolean
  interrupted: boolean
}): boolean {
  const rawWorking =
    args.isConversation &&
    !args.hookTurnCompletedByTranscript &&
    (args.viewWorking || args.hookWorking)
  return rawWorking && !args.interrupted
}

export function shouldClearNativeChatWorkingSuppression(args: {
  viewWorking: boolean
  hookWorking: boolean
}): boolean {
  return !args.viewWorking && !args.hookWorking
}
