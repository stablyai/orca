// Owns one Chat view's optimistic echo queue: the rendered state, the
// pane-scoped cache behind it, and the retractions other views publish into it.
// Extracted from NativeChatResolvedView so the cross-view case — an echo
// retracted after the sending view unmounted and a replacement view already
// mounted — is testable without rendering the whole chat surface.

import { useCallback, useEffect, useState } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  appendPendingSendCache,
  nextNativeChatPendingSendId,
  prunePendingSends,
  readPendingSendCache,
  writePendingSendCache,
  type NativeChatPendingSend,
  type NativeChatPendingSendScope
} from './native-chat-pending'
import {
  retractAllPendingSends,
  retractPendingSendCache,
  subscribeToPendingSendRetractions
} from './native-chat-pending-retraction'

export type NativeChatPendingSends = {
  pending: NativeChatPendingSend[]
  /** Echoes a submitted draft, returning the id that retracts it. */
  issue: (text: string, imagePaths?: string[]) => string
  /** Takes the echo back when the send is known not to have been delivered. */
  retract: (pendingId: string) => void
  /** Drops the whole queue — Stop discards the turn the echoes belong to. */
  clearAll: () => void
}

export function useNativeChatPendingSends(args: {
  scope: NativeChatPendingSendScope
  messages: NativeChatMessage[]
}): NativeChatPendingSends {
  const { scope, messages } = args
  const [pending, setPending] = useState<NativeChatPendingSend[]>(() => readPendingSendCache(scope))
  // Reset only when the pane/agent changes. A fresh launch often learns its
  // provider session id after the first send; clearing on that transition
  // briefly flashes the empty state before the transcript user turn lands.
  useEffect(() => {
    setPending(readPendingSendCache(scope))
  }, [scope])
  // The retraction can originate in a view that has already unmounted, so this
  // view follows the cache instead of assuming its own snapshot is current.
  useEffect(
    () =>
      subscribeToPendingSendRetractions(scope, (pendingId) => {
        setPending((previous) => previous.filter((entry) => entry.id !== pendingId))
      }),
    [scope]
  )
  // Prune echoes whose real user turn is now in the transcript.
  useEffect(() => {
    setPending((previous) => writePendingSendCache(scope, prunePendingSends(previous, messages)))
  }, [messages, scope])
  const issue = useCallback(
    (text: string, imagePaths?: string[]) => {
      const sentAt = Date.now()
      const boundary = messages.at(-1)
      const entry: NativeChatPendingSend = {
        id: nextNativeChatPendingSendId(sentAt),
        text,
        sentAt,
        afterMessageId: boundary?.id ?? null,
        afterMessageTimestamp: boundary?.timestamp ?? null,
        ...(imagePaths ? { imagePaths } : {})
      }
      setPending(appendPendingSendCache(scope, entry))
      return entry.id
    },
    [messages, scope]
  )
  // No local `setPending` here: the subscription above is the single path, so a
  // retraction lands identically whichever view issued it.
  const retract = useCallback(
    (pendingId: string) => {
      retractPendingSendCache(scope, pendingId)
    },
    [scope]
  )
  const clearAll = useCallback(() => {
    retractAllPendingSends(scope)
  }, [scope])
  return { pending, issue, retract, clearAll }
}
