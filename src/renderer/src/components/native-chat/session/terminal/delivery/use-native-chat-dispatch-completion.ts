import { useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
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
  const dispatchObservers = useMemo(
    () => ({
      scope,
      seen: new WeakSet<Promise<NativeChatPendingDispatchOutcome>>(),
      reconcile: null as
        | null
        | ((
            id: string,
            promise: Promise<NativeChatPendingDispatchOutcome>,
            outcome: NativeChatPendingDispatchOutcome
          ) => void)
    }),
    [scope]
  )
  useLayoutEffect(() => {
    dispatchObservers.reconcile = (id, promise, outcome) => {
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
      dispatchObservers.reconcile = null
    }
  }, [dispatchObservers, save, messages, sessionId])
  useEffect(() => {
    for (const entry of pending) {
      const promise = entry.dispatchOutcome
      if (!entry.dispatchPending || !promise || dispatchObservers.seen.has(promise)) {
        continue
      }
      dispatchObservers.seen.add(promise)
      const id = entry.id
      void promise.then((outcome) => dispatchObservers.reconcile?.(id, promise, outcome))
    }
  }, [pending, scope, dispatchObservers])
  return finishDispatch
}
