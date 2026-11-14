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
  skillOriginRef: RefObject<string | null>,
  prefix: '$' | '/' | null
) {
  return useCallback(
    (value: string) => {
      const outcome = classifyNativeChatSend(value, commands, skillOriginRef.current, prefix)
      emitNativeChatSendClassified({ agent, outcome })
      return outcome
    },
    [agent, commands, prefix, skillOriginRef]
  )
}

export function useNativeChatPickedSkillOrigin(originRef: RefObject<string | null>) {
  const clearSkillOrigin = useCallback(() => {
    originRef.current = null
  }, [originRef])
  const isPickedSkill = useCallback(
    (value: string) => originRef.current === (value.split(/\s/, 1)[0] ?? ''),
    [originRef]
  )
  return { clearSkillOrigin, isPickedSkill }
}
