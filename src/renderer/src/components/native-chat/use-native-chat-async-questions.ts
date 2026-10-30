import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import {
  aggregateAsyncQuestions,
  scanPendingAsks
} from '../../../../shared/native-chat/input/native-chat-ask'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { nativeChatPromptDismissals as dismissals } from './native-chat-prompt-dismissals'
import { createUseMessageQuestionCancel } from '../../../../shared/native-chat/use-message-question-cancel'
import type { MessageQuestionView } from '../../../../shared/message-question-occurrence'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

const useMessageQuestionCancel = createUseMessageQuestionCancel({
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
})

export function useNativeChatAsyncQuestions({
  paneKey,
  sourceKey,
  sourceScope,
  viewKey,
  messages,
  settled,
  messageQuestions,
  cancelMessageQuestions
}: {
  paneKey: string
  sourceKey: string
  sourceScope: string
  viewKey: string | null
  messages: readonly NativeChatMessage[]
  settled: boolean
  messageQuestions?: MessageQuestionView
  cancelMessageQuestions?: (ids: readonly string[]) => Promise<void>
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
  const actions = useMessageQuestionCancel({
    sourceKey: JSON.stringify([scopeKey, viewKey]),
    view: messageQuestions,
    cancel: cancelMessageQuestions,
    error: () =>
      toast.error(
        translate(
          'components.native-chat.question.cancelFailed',
          'Could not cancel the questions. Try again.'
        )
      )
  })
  const legacyPrompt = useMemo(
    () => aggregateAsyncQuestions(scan?.contributors ?? [], sourceScope, hidden),
    [scan, sourceScope, hidden]
  )
  const prompt = messageQuestions === undefined ? legacyPrompt : actions.prompt
  const dismiss = useCallback(() => {
    if (messageQuestions === undefined && active.current === owner) {
      dismissals.hideAsync(scopeKey, prompt?.occurrenceIds ?? [])
    }
  }, [owner, scopeKey, prompt, messageQuestions])
  return {
    prompt,
    blocking: scan?.blocking ?? null,
    dismiss,
    cancel: () =>
      messageQuestions === undefined ? dismiss() : void actions.cancel(prompt?.occurrenceIds ?? []),
    ready: messageQuestions === undefined || actions.ready,
    ownerKey: JSON.stringify([scopeKey, viewKey])
  }
}
