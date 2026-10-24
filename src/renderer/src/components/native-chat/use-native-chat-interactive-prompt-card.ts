import { useAgentStatusField } from '@/store/agent-status'
import { useMemo } from 'react'
import { resolveNativeChatAsk } from '../../../../shared/native-chat-ask'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  parseInteractivePrompt,
  type InteractivePromptCard
} from './native-chat-interactive-prompt'

/**
 * The prompt a terminal-backed pane can draw as a card: a tool approval from the
 * live status, else a question from the live status or, failing that, from the
 * transcript's unresolved ask (headless host, relay gap, replay, reconnect — a
 * pane parked on a selector must not take the next message as its answer, #11761).
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
  const interactivePrompt = useAgentStatusField(
    paneKey,
    (entry) => entry?.interactivePrompt ?? null
  )
  // The sibling `toolName` lets the question parser dispatch through the tool's
  // registered parser (mobile parity). Read only beside a prompt: it changes on
  // every tool call, and this hook re-renders the whole pane.
  const interactiveToolName = useAgentStatusField(paneKey, (entry) => {
    return entry?.interactivePrompt ? (entry.toolName ?? null) : null
  })
  const agent = useAgentStatusField(paneKey, (entry) => entry?.agentType)
  return useMemo(() => {
    const statusCard = parseInteractivePrompt(
      interactivePrompt,
      interactiveToolName ?? undefined,
      agent
    )
    if (statusCard?.kind === 'approval') {
      return statusCard
    }
    const prompt = resolveNativeChatAsk({
      liveAsk: statusCard?.prompt ?? null,
      messages,
      transcriptSettled
    })
    return prompt ? { kind: 'question' as const, prompt } : null
  }, [interactivePrompt, interactiveToolName, agent, messages, transcriptSettled])
}
