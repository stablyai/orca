import { asyncQuestionSourceScope } from '../../../../shared/native-chat/input/native-chat-ask'
import { useNativeChatAsyncQuestions } from './use-native-chat-async-questions'
import { useNativeChatPromptCardPresentation } from './use-native-chat-prompt-card-presentation'
import { useMemo } from 'react'
import { useAppStore } from '../../store'
import type { AskPrompt } from '../../../../shared/native-chat/input/native-chat-ask-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { resolveNativeChatInteractivePromptCard } from '../../../../shared/native-chat-interactive-prompt'
import { sayNativeChatApprovalTranslated } from './native-chat-interactive-prompt'
import type { InteractivePromptCard } from '../../../../shared/native-chat-interactive-prompt'

export function useNativeChatInteractivePromptCard({
  paneKey,
  messages,
  transcriptSettled,
  transcriptAsk
}: {
  paneKey: string
  /** Pass the command-boundary-trimmed messages so an ask abandoned via `/clear` stays gone. */
  messages: readonly NativeChatMessage[]
  transcriptSettled: boolean
  transcriptAsk?: AskPrompt | null
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
        transcriptAsk,
        say: sayNativeChatApprovalTranslated
      }),
    [interactivePrompt, interactiveToolName, agent, messages, transcriptSettled, transcriptAsk]
  )
}

export function useNativeChatTerminalPromptCard(args: {
  paneKey: string
  targetPtyId: string | null
  runtimeEnvironmentId: string | null | undefined
  agent: string
  sessionId: string | null
  transcriptPath: string | null
  messages: readonly NativeChatMessage[]
  transcriptSettled: boolean
  canSend: boolean
}) {
  const {
    paneKey,
    targetPtyId,
    runtimeEnvironmentId,
    agent,
    sessionId,
    transcriptPath,
    messages,
    transcriptSettled,
    canSend
  } = args
  const asyncQuestions = useNativeChatAsyncQuestions({
    paneKey,
    viewKey: targetPtyId,
    sourceKey: JSON.stringify([
      'transcript',
      runtimeEnvironmentId ?? null,
      agent,
      sessionId,
      transcriptPath
    ]),
    sourceScope: asyncQuestionSourceScope({ kind: 'transcript', agent, sessionId, transcriptPath }),
    messages,
    settled: transcriptSettled
  })
  const promptCard = useNativeChatInteractivePromptCard({
    paneKey,
    messages,
    transcriptSettled,
    transcriptAsk: asyncQuestions.blocking ?? asyncQuestions.prompt
  })
  const presentation = useNativeChatPromptCardPresentation({
    paneKey,
    targetPtyId,
    card: promptCard,
    dismissAsync: asyncQuestions.dismiss,
    canSend,
    transcriptSettled
  })
  const mounted = presentation.card ?? presentation.collapsedCard
  const actionKey =
    mounted?.kind === 'question' && mounted.prompt.replyAsMessage
      ? asyncQuestions.ownerKey
      : (presentation.occurrenceKey ?? 'prompt')
  return { promptCard, presentation, actionKey }
}
