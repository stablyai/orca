import { useCallback, useMemo, useState } from 'react'
import {
  reduceNativeChatAsyncQuestionsView,
  pendingAsyncQuestionGroups,
  type NativeChatAsyncQuestionsView
} from '../../../../shared/native-chat-pending-async-questions'
import type { NativeChatSubscriptionFrame } from '../../../../preload/api/native-chat-api'

/** Keeps a pending set only for the transcript source that published it. */
export function useNativeChatPendingAsyncQuestions(args: {
  paneKey: string
  agent: string
  sessionId: string | null
  runtimeEnvironmentId?: string | null
  transcriptPath?: string | null
}) {
  const source = JSON.stringify([
    args.paneKey,
    args.runtimeEnvironmentId ?? null,
    args.agent,
    args.sessionId,
    args.transcriptPath ?? null
  ])
  const [state, setState] = useState<{ source: string; view: NativeChatAsyncQuestionsView } | null>(
    null
  )
  const applyFrame = useCallback(
    (frame: NativeChatSubscriptionFrame) => {
      setState((previous) => {
        const view = reduceNativeChatAsyncQuestionsView(
          previous?.source === source ? previous.view : { state: 'absent' },
          frame
        )
        return previous?.source === source && previous.view === view ? previous : { source, view }
      })
    },
    [source]
  )
  const groups = useMemo(
    () => (state?.source === source ? pendingAsyncQuestionGroups(state.view) : undefined),
    [state, source]
  )
  return [groups, applyFrame, source] as const
}
