// The approval or question one of a bot's chats waits on, so Needs you can answer it in place.
import { botTarget, type BotOnHost } from '@/lib/bot-hosts'
import { useCallback, useEffect, useRef } from 'react'
import { useStructuredAgentSessionRead } from '../native-chat/session/structured/read/use-structured-agent-session-read'
import { useStructuredAgentSessionMutate } from '../native-chat/session/structured/writes/use-structured-agent-session-mutate'
import { useStructuredPromptResponseHold } from '../native-chat/prompts/use-structured-prompt-response-hold'
import { respondToStructuredAgentSessionPrompt } from '../native-chat/prompts/structured-agent-session-prompt-response'
import {
  pendingStructuredSessionPrompts,
  type StructuredPromptItem
} from '../../../../shared/agent-session/view/structured-agent-session-message-projection'
import type { AgentSessionPromptResponse } from '../../../../shared/agent-session/requests/prompts/agent-session-question-answer'

export type BotSessionPrompt = {
  prompt: StructuredPromptItem | null
  respond: (item: StructuredPromptItem, response: AgentSessionPromptResponse) => Promise<unknown>
  holds: (item: StructuredPromptItem) => boolean
}

/**
 * Reads the chat as its tab would, without holding its agent or marking it seen: the owner has only
 * glanced at the row. Mounted only for the few rows in Needs you.
 */
export function useBotSessionPrompt(bot: BotOnHost, sessionId: string): BotSessionPrompt {
  const target = botTarget(bot)
  const read = useStructuredAgentSessionRead({
    sessionId,
    target,
    isVisible: true,
    isViewed: false
  })
  const stateRef = useRef(read.state)
  useEffect(() => {
    stateRef.current = read.state
  }, [read.state])
  const { admit } = useStructuredAgentSessionMutate({ sessionId, target, stateRef })
  const respond = useCallback(
    (item: StructuredPromptItem, response: AgentSessionPromptResponse) =>
      respondToStructuredAgentSessionPrompt({ item, response, action: admit() }),
    [admit]
  )
  const hold = useStructuredPromptResponseHold(respond)
  const [prompt] = pendingStructuredSessionPrompts({
    journalItems: read.state.items,
    currentRequests: read.state.currentRequests,
    actionablePromptIds: read.state.actionablePromptIds
  })
  return { prompt: prompt ?? null, respond: hold.respond, holds: hold.holds }
}
