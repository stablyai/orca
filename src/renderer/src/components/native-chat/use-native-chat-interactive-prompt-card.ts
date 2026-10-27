import { useMemo } from 'react'
import { useAppStore } from '../../store'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { resolveNativeChatInteractivePromptCard } from '../../../../shared/native-chat-interactive-prompt'
import { sayNativeChatApprovalTranslated } from './native-chat-interactive-prompt'
import type { InteractivePromptCard } from '../../../../shared/native-chat-interactive-prompt'

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
  // Read toolName only beside a prompt for parser dispatch; ordinary tool changes would rerender the whole pane.
  const interactiveToolName = useAppStore((s) => {
    const entry = s.agentStatusByPaneKey[paneKey]
    return entry?.interactivePrompt ? (entry.toolName ?? null) : null
  })
  const agent = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.agentType)
  return useMemo(
    () =>
      resolveNativeChatInteractivePromptCard({
        interactivePrompt,
        toolName: interactiveToolName ?? undefined,
        agent,
        messages,
        transcriptSettled,
        say: sayNativeChatApprovalTranslated
      }),
    [interactivePrompt, interactiveToolName, agent, messages, transcriptSettled]
  )
}
