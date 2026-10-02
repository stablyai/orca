import type { NativeChatMessage } from '../../../../shared/native-chat-types'

export function failedNativeChatLaunchPromptIds(
  failed: boolean | undefined,
  launchMessageId: string | undefined,
  messages: readonly NativeChatMessage[]
): ReadonlySet<string> | undefined {
  if (!failed || !launchMessageId || !messages.some((message) => message.id === launchMessageId)) {
    return undefined
  }
  return new Set([launchMessageId])
}
