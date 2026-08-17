import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatTranscriptOrder } from './native-chat-transcript-order'
import {
  appendPendingSendCache,
  nextNativeChatPendingSendId,
  prunePendingSends,
  readPendingSendCache,
  writePendingSendCache,
  type NativeChatPendingSend,
  type NativeChatPendingSendScope
} from './native-chat-pending'

export function useNativeChatPendingSends(args: {
  scope: NativeChatPendingSendScope
  messages: readonly NativeChatMessage[]
  order: NativeChatTranscriptOrder
  onSendStarted: () => void
}): {
  pending: NativeChatPendingSend[]
  clearPending: () => void
  onOptimisticSend: (text: string, imagePaths?: string[]) => string
  onOptimisticSendCanceled: (pendingId: string) => void
} {
  const { scope, messages, order, onSendStarted } = args
  const [pending, setPending] = useState<NativeChatPendingSend[]>(() => readPendingSendCache(scope))
  const pendingGenerationRef = useRef(order.generation)

  useEffect(() => {
    setPending(readPendingSendCache(scope))
  }, [scope])
  useEffect(() => {
    if (pendingGenerationRef.current !== order.generation) {
      // A source rebind invalidates pane-local optimistic sends.
      setPending(writePendingSendCache(scope, []))
    }
    pendingGenerationRef.current = order.generation
  }, [order.generation, scope])
  useEffect(() => {
    setPending((previous) =>
      writePendingSendCache(scope, prunePendingSends(previous, [...messages], order))
    )
  }, [messages, order, scope])

  const clearPending = useCallback(() => {
    setPending(writePendingSendCache(scope, []))
  }, [scope])
  const onOptimisticSend = useCallback(
    (text: string, imagePaths?: string[]) => {
      onSendStarted()
      const sentAt = Date.now()
      const boundary = messages.at(-1)
      const entry: NativeChatPendingSend = {
        id: nextNativeChatPendingSendId(sentAt),
        text,
        sentAt,
        afterMessageId: boundary?.id ?? null,
        afterMessageTimestamp: boundary?.timestamp ?? null,
        afterTranscriptGeneration: order.generation,
        afterTranscriptHighWater: order.highWater,
        ...(imagePaths ? { imagePaths } : {})
      }
      setPending(appendPendingSendCache(scope, entry))
      return entry.id
    },
    [messages, onSendStarted, order, scope]
  )
  const onOptimisticSendCanceled = useCallback(
    (pendingId: string) => {
      const next = readPendingSendCache(scope).filter((entry) => entry.id !== pendingId)
      setPending(writePendingSendCache(scope, next))
    },
    [scope]
  )

  return { pending, clearPending, onOptimisticSend, onOptimisticSendCanceled }
}
