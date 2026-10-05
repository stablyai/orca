import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type {
  NativeChatAsyncAnswerOutcome,
  NativeChatAsyncQuestionEdit,
  NativeChatAsyncQuestionEdits
} from '../../../../shared/native-chat-async-question-answers'
import type { NativeChatAsyncAnswerProgress } from '../../../../shared/native-chat-async-answer-progress'
import {
  nativeChatAsyncQuestionScopeView,
  submitNativeChatAsyncQuestionScope
} from '../../../../shared/native-chat-async-question-card-state'
import type {
  NativeChatAsyncQuestion,
  NativeChatAsyncQuestionsView
} from '../../../../shared/native-chat-async-questions'
import {
  dispatchNativeChatAsyncQuestionCard,
  pruneNativeChatAsyncQuestionCardScope,
  readNativeChatAsyncQuestionCardScope,
  subscribeNativeChatAsyncQuestionCardScope
} from './native-chat-async-question-card-store'

/** Delivers one formatted answer through the pane's ordinary message seam, settled honestly. */
export type NativeChatAsyncAnswerSend = (
  text: string,
  answers: Record<string, string>
) => Promise<NativeChatAsyncAnswerOutcome>

export type NativeChatAsyncQuestionsCardModel = {
  open: NativeChatAsyncQuestion[]
  omittedCount: number
  edits: NativeChatAsyncQuestionEdits
  /** Questions whose sent answer is still on its way: shown read-only. */
  held: ReadonlySet<string>
  sending: boolean
  canSend: boolean
  edit: (key: string, edit: NativeChatAsyncQuestionEdit) => void
  dismiss: (key: string) => void
  submit: () => void
}

const NO_PROGRESS: NativeChatAsyncAnswerProgress = { answers: {}, sendingKeys: new Set() }

/**
 * The async question card for one conversation, keyed by question so a question added
 * while another is edited, dismissed or sent changes nothing for it. Its state lives in the
 * card store, so it survives the pane's terminal↔chat toggle. The card stays until the
 * host's set drops a question; a question is read-only only while its own answer is on its way.
 */
export function useNativeChatAsyncQuestions(args: {
  /** Pane + session: edits never carry over to another conversation. */
  scopeKey: string
  view: NativeChatAsyncQuestionsView
  send: NativeChatAsyncAnswerSend
  /** Answers the transport itself still holds (its outbox, or a terminal echo still waiting). */
  progress?: NativeChatAsyncAnswerProgress
}): NativeChatAsyncQuestionsCardModel {
  const { scopeKey, view, send, progress = NO_PROGRESS } = args
  const scope = useSyncExternalStore(
    useCallback(
      (listener: () => void) => subscribeNativeChatAsyncQuestionCardScope(scopeKey, listener),
      [scopeKey]
    ),
    () => readNativeChatAsyncQuestionCardScope(scopeKey)
  )
  // Only an authoritative set retires a question's state.
  useEffect(() => pruneNativeChatAsyncQuestionCardScope(scopeKey, view), [scopeKey, view])
  const returned = scope.returned
  const card = useMemo(() => {
    const held = Object.keys(returned).length
      ? { ...progress, answers: { ...progress.answers, ...returned } }
      : progress
    return nativeChatAsyncQuestionScopeView(scope, view, held)
  }, [progress, returned, scope, view])

  const edit = useCallback(
    (key: string, next: NativeChatAsyncQuestionEdit) =>
      dispatchNativeChatAsyncQuestionCard(scopeKey, { type: 'edit', key, edit: next }),
    [scopeKey]
  )
  const dismiss = useCallback(
    (key: string) => dispatchNativeChatAsyncQuestionCard(scopeKey, { type: 'dismiss', key }),
    [scopeKey]
  )
  const submit = (): void =>
    submitNativeChatAsyncQuestionScope(
      { scopeKey, ...card },
      (action) => dispatchNativeChatAsyncQuestionCard(scopeKey, action),
      send
    )

  return {
    open: card.open,
    omittedCount: card.omittedCount,
    edits: card.edits,
    held: card.held,
    sending: card.sending,
    canSend: card.canSend,
    edit,
    dismiss,
    submit
  }
}
