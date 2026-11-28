import { useCallback, type RefObject } from 'react'
import {
  classifyNativeChatSend,
  type NativeChatSendClassification,
  type SlashCommandSuggestion
} from '../../../../../../shared/native-chat/input/commands/native-chat-slash-commands'

/** How Enter would send a draft; `peekSendClassification` asks without starting a send. */
export function useNativeChatSendClassification(
  agentCommands: readonly SlashCommandSuggestion[],
  skillOriginRef: RefObject<string | null>,
  skillPrefix: Parameters<typeof classifyNativeChatSend>[3]
): {
  classifySend: (draft: string) => NativeChatSendClassification
  peekSendClassification: (draft: string) => NativeChatSendClassification
} {
  const peekSendClassification = useCallback(
    (value: string) =>
      classifyNativeChatSend(value, agentCommands, skillOriginRef.current, skillPrefix),
    [agentCommands, skillOriginRef, skillPrefix]
  )
  return { classifySend: peekSendClassification, peekSendClassification }
}
