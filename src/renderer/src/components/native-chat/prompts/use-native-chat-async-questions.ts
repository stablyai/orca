import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  aggregateAsyncQuestions,
  newestShownAsyncQuestionRow,
  scanPendingAsks
} from '../../../../../shared/native-chat/input/native-chat-ask'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { nativeChatPromptDismissals as dismissals } from './native-chat-prompt-dismissals'
import { asyncQuestionsAfterSkip } from '../../../../../shared/agent-session/view/structured-agent-session-async-questions'
import type { StructuredAgentSessionAsyncQuestionSkip } from './use-structured-agent-session-async-question-skip'

export function useNativeChatAsyncQuestions({
  paneKey,
  sourceKey,
  sourceScope,
  viewKey,
  messages,
  settled,
  queuedTexts,
  skip
}: {
  paneKey: string
  sourceKey: string
  sourceScope: string
  viewKey: string | null
  messages: readonly NativeChatMessage[]
  settled: boolean
  /** Texts waiting in the chat's queue; one quoting a question holds it as answered. */
  queuedTexts?: readonly string[]
  /** The host's saved Skip, on a host that keeps one for every device. */
  skip?: StructuredAgentSessionAsyncQuestionSkip
}) {
  const scopeKey = `${paneKey}:async:${sourceKey}`
  const owner = useMemo(() => ({ scopeKey, viewKey }), [scopeKey, viewKey])
  const active = useRef<object | null>(null)
  useLayoutEffect(() => {
    active.current = owner
    return () => {
      active.current = null
    }
  }, [owner])
  useLayoutEffect(() => () => dismissals.forgetAsync(scopeKey), [scopeKey])
  const hidden = useSyncExternalStore(dismissals.subscribe, () => dismissals.readAsync(scopeKey))
  const scan = useMemo(() => (settled ? scanPendingAsks(messages) : null), [messages, settled])
  const skippedThrough = skip?.skippedThrough
  const contributors = useMemo(
    () => asyncQuestionsAfterSkip(scan?.contributors ?? [], skippedThrough),
    [scan, skippedThrough]
  )
  const prompt = useMemo(
    () => aggregateAsyncQuestions(contributors, sourceScope, hidden, queuedTexts),
    [contributors, sourceScope, hidden, queuedTexts]
  )
  const save = skip?.save
  const dismiss = useCallback(() => {
    if (active.current !== owner) {
      return
    }
    const ids = prompt?.occurrenceIds ?? []
    dismissals.hideAsync(scopeKey, ids)
    const newest = newestShownAsyncQuestionRow(contributors, sourceScope, prompt)
    // A Skip the host did not save shows its card again, as the status still waits on it.
    if (save && newest) {
      void save(newest).catch(() => dismissals.forgetAsync(scopeKey, ids))
    }
  }, [owner, scopeKey, prompt, contributors, sourceScope, save])
  return {
    prompt,
    answerPending: scan?.answerPending === true,
    blocking: scan?.blocking ?? null,
    dismiss,
    ownerKey: JSON.stringify([scopeKey, viewKey])
  }
}
