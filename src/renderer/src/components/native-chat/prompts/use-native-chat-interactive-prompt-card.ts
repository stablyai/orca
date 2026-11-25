import { useAgentStatus, useAgentStatusSelector } from '@/runtime/agent-status/use-agent-status'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { asyncQuestionSourceScope } from '../../../../../shared/native-chat/input/native-chat-ask'
import { useNativeChatAsyncQuestions } from './use-native-chat-async-questions'
import { useNativeChatPromptCardPresentation } from './use-native-chat-prompt-card-presentation'
import { useEffect, useMemo, useState } from 'react'
import { parseTerminalChoicePrompt } from '../../../../../shared/native-chat/input/native-chat-terminal-choice-prompt'
import { useAppStore } from '../../../store/index'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type { AskPrompt } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { resolveNativeChatInteractivePromptCard } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { sayNativeChatApprovalTranslated } from './native-chat-interactive-prompt'
import type { InteractivePromptCard } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'

export function useNativeChatInteractivePromptCard({
  paneKey,
  messages,
  transcriptSettled,
  transcriptAsk,
  readTerminalScreen
}: {
  /** A terminal chat's screen, read when the agent waits on a choice it published no prompt for. */
  readTerminalScreen?: () => string | null
  paneKey: string
  /** Pass the command-boundary-trimmed messages so an ask abandoned via `/clear` stays gone. */
  messages: readonly NativeChatMessage[]
  transcriptSettled: boolean
  transcriptAsk?: AskPrompt | null
}): InteractivePromptCard {
  const interactivePrompt = useAgentStatus(paneKey)?.interactivePrompt ?? null
  // Read toolName only beside a prompt for parser dispatch; ordinary tool changes would rerender the whole pane.
  const interactiveToolName = useAppStore((s) => {
    const entry = s.agentStatusByPaneKey.get(paneKey)
    return entry?.interactivePrompt ? (entry.toolName ?? null) : null
  })
  const agent = useAgentStatus(paneKey)?.agentType
  const waiting = useAgentStatusSelector(paneKey, isAgentWaiting)
  const card = useMemo(
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
  const screenChoice = useWaitingScreenChoice(
    waiting && card === null ? readTerminalScreen : undefined
  )
  return card ?? (screenChoice ? { kind: 'approval', approval: screenChoice } : null)
}

const SCREEN_CHOICE_POLL_MS = 750

function isAgentWaiting(entry: AgentStatusEntry | undefined): boolean {
  return entry?.state === 'waiting' || entry?.state === 'blocked'
}

/** While the agent waits with no prompt of its own, the numbered choice its terminal shows. */
function useWaitingScreenChoice(readTerminalScreen: (() => string | null) | undefined) {
  const [read, setRead] = useState<{
    reader: () => string | null
    choice: ReturnType<typeof parseTerminalChoicePrompt>
  } | null>(null)
  useEffect(() => {
    if (!readTerminalScreen) {
      return
    }
    let last = ''
    const run = (): void => {
      const choice = parseTerminalChoicePrompt(readTerminalScreen())
      const key = JSON.stringify(choice)
      if (key !== last) {
        last = key
        setRead({ reader: readTerminalScreen, choice })
      }
    }
    // The screen draws the menu a moment after the waiting status lands, and it can change.
    return installWindowVisibilityInterval({ run, intervalMs: SCREEN_CHOICE_POLL_MS })
  }, [readTerminalScreen])
  // A result read through an earlier reader is stale once the reader changes or goes away.
  return readTerminalScreen && read?.reader === readTerminalScreen ? read.choice : null
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
  readTerminalScreen?: () => string | null
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
    canSend,
    readTerminalScreen
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
    transcriptAsk: asyncQuestions.blocking ?? asyncQuestions.prompt,
    ...(readTerminalScreen ? { readTerminalScreen } : {})
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
