import { useAgentStatusField } from '@/store/agent-status'
import { useMemo } from 'react'
import { resolveNativeChatAsk } from '../../../../shared/native-chat-ask'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  parseInteractivePrompt,
  type InteractivePromptCard
} from './native-chat-interactive-prompt'

/** Prefer live approvals/questions, then unresolved transcript asks, so a parked selector cannot consume the next message as its answer. */
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
  // Read toolName only beside a prompt for parser dispatch; ordinary tool changes would rerender the whole pane.
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
