import { useCallback, type RefObject } from 'react'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import {
  classifyNativeChatSend,
  type SlashCommandSuggestion
} from '../../../../../../shared/native-chat/input/native-chat-slash-commands'
import { emitNativeChatSendClassified } from '@/components/native-chat/telemetry/native-chat-telemetry'

export function useNativeChatSendClassification(
  agent: AgentType,
  commands: readonly SlashCommandSuggestion[],
  skillOrigin: RefObject<string | null>,
  prefix: '$' | '/' | null
) {
  return useCallback(
    (value: string) => {
      const outcome = classifyNativeChatSend(value, commands, skillOrigin.current, prefix)
      emitNativeChatSendClassified({ agent, outcome })
      return outcome
    },
    [agent, commands, prefix, skillOrigin]
  )
}

export function useNativeChatPickedSkillOrigin(origin: { current: string | null }) {
  const clearSkillOrigin = useCallback(() => {
    origin.current = null
  }, [origin])
  const isPickedSkill = useCallback(
    (value: string) => origin.current === (value.split(/\s/, 1)[0] ?? ''),
    [origin]
  )
  return { clearSkillOrigin, isPickedSkill }
}
