import { useCallback, type RefObject } from 'react'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import {
  classifyNativeChatSend,
  type NativeChatSendClassification,
  type SlashCommandSuggestion
} from '../../../../../../shared/native-chat/input/commands/native-chat-slash-commands'
import { emitNativeChatSendClassified } from '@/components/native-chat/telemetry/native-chat-telemetry'

/** How Enter would send a draft: `classifySend` records the decision, `peekSendClassification` only asks. */
export function useNativeChatSendClassification(
  agent: AgentType,
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
  const classifySend = useCallback(
    (value: string) => {
      const outcome = peekSendClassification(value)
      emitNativeChatSendClassified({ agent, outcome })
      return outcome
    },
    [agent, peekSendClassification]
  )
  return { classifySend, peekSendClassification }
}
