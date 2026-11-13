import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  prunePendingSends,
  releaseEmptyTranscriptClaims,
  type NativeChatPendingDispatchOutcome,
  type NativeChatPendingSend
} from '../../../../../../../shared/native-chat/transcript/native-chat-pending-sends'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { finishPendingSendDispatch, type NativeChatPendingSendScope } from './native-chat-pending'

/** A remounted view observes the existing operation without retaining an old transcript snapshot. */
export function useNativeChatDispatchCompletion({
  scope,
  pending,
  save,
  messages,
  sessionId
}: {
  scope: NativeChatPendingSendScope
  pending: NativeChatPendingSend[]
  save: (update: (entries: NativeChatPendingSend[]) => NativeChatPendingSend[]) => void
  messages: NativeChatMessage[]
  sessionId: string | null
}) {
  const finishDispatch = useCallback(
    (
      id: string,
      promise: Promise<NativeChatPendingDispatchOutcome>,
      outcome: NativeChatPendingDispatchOutcome
    ) => save((entries) => finishPendingSendDispatch(entries, id, promise, outcome)),
    [save]
  )
  const dispatchObservers = useRef<{
    scope: NativeChatPendingSendScope
    seen: WeakSet<Promise<NativeChatPendingDispatchOutcome>>
    reconcile:
      | null
      | ((
          id: string,
          promise: Promise<NativeChatPendingDispatchOutcome>,
          outcome: NativeChatPendingDispatchOutcome
        ) => void)
  } | null>(null)
  useLayoutEffect(() => {
    let observer = dispatchObservers.current
    if (observer?.scope !== scope) {
      observer = {
        scope,
        seen: new WeakSet<Promise<NativeChatPendingDispatchOutcome>>(),
        reconcile: null
      }
      dispatchObservers.current = observer
    }
    observer.reconcile = (id, promise, outcome) => {
      save((entries) =>
        prunePendingSends(
          releaseEmptyTranscriptClaims(
            finishPendingSendDispatch(entries, id, promise, outcome),
            sessionId
          ),
          messages,
          sessionId ?? ''
        )
      )
    }
    return () => {
      observer.reconcile = null
    }
  }, [scope, save, messages, sessionId])
  useEffect(() => {
    const observer = dispatchObservers.current
    if (!observer || observer.scope !== scope) {
      return
    }
    for (const entry of pending) {
      const promise = entry.dispatchOutcome
      if (!entry.dispatchPending || !promise || observer.seen.has(promise)) {
        continue
      }
      observer.seen.add(promise)
      const id = entry.id
      void promise.then((outcome) => observer.reconcile?.(id, promise, outcome))
    }
  }, [pending, scope])
  return finishDispatch
}
