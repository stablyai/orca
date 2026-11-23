import type { NativeChatMessage } from './native-chat-types'

export function isNativeChatPromptRow(message: NativeChatMessage): boolean {
  return (
    message.role === 'user' &&
    message.orcaNotice === undefined &&
    message.from === undefined &&
    message.stoppedBeforeStart !== true
  )
}
