import { useMemo } from 'react'
import { useAppStore } from '../../store'
import { NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT } from '../../../../shared/native-chat-async-questions'
import { resolveTerminalChatDecision } from '../../../../shared/native-chat-pending-decision'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  interactivePromptCardFromDecision,
  type InteractivePromptCard
} from './native-chat-interactive-prompt'

/**
 * The prompt a terminal-backed pane can draw as a card, from the shared resolver: an
 * approval or unplaceable request only while the agent waits (STA-3144), else a live
 * question while it waits or, failing that, the transcript's unresolved ask (headless
 * host, relay gap, replay, reconnect — a pane parked on a selector must not take the
 * next message as its answer, #11761).
 */
export function useNativeChatInteractivePromptCard({
  paneKey,
  messages,
  transcriptSettled
}: {
  paneKey: string
  /** Pass the command-boundary-trimmed messages so an ask abandoned via `/clear` stays gone. */
  messages: readonly NativeChatMessage[]
  transcriptSettled: boolean
}): InteractivePromptCard {
  const interactivePrompt = useAppStore(
    (s) => s.agentStatusByPaneKey[paneKey]?.interactivePrompt ?? null
  )
  // The sibling `toolName` lets the question parser dispatch through the tool's
  // registered parser (mobile parity). Read only beside a prompt: it changes on
  // every tool call, and this hook re-renders the whole pane.
  const interactiveToolName = useAppStore((s) => {
    const entry = s.agentStatusByPaneKey[paneKey]
    return entry?.interactivePrompt ? (entry.toolName ?? null) : null
  })
  const state = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.state)
  const agent = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.agentType)
  return useMemo(() => {
    const { decision } = resolveTerminalChatDecision({
      status: { state, interactivePrompt, toolName: interactiveToolName },
      messages,
      transcriptSettled,
      // Desktop runs no prose heuristics, so the async set does not gate anything here.
      asyncQuestions: NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT
    })
    return interactivePromptCardFromDecision(decision, agent)
  }, [state, interactivePrompt, interactiveToolName, agent, messages, transcriptSettled])
}
