import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  appendNativeChatTranscriptOrder,
  createNativeChatTranscriptOrder,
  replaceNativeChatTranscriptOrder,
  settleNativeChatTranscriptOrder,
  type NativeChatTranscriptOrder
} from './native-chat-transcript-order'

/** Narrow the lazy-seeded ref; create only if somehow still empty. */
function readSeededTranscriptOrder(
  ref: MutableRefObject<NativeChatTranscriptOrder | null>
): NativeChatTranscriptOrder {
  const existing = ref.current
  if (existing !== null) {
    return existing
  }
  const created = createNativeChatTranscriptOrder()
  ref.current = created
  return created
}

export function useNativeChatTranscriptOrder(): readonly [
  NativeChatTranscriptOrder,
  () => void,
  (messages: readonly NativeChatMessage[], retainedCount: number) => void,
  (messages: readonly NativeChatMessage[], retainedCount: number) => void
] {
  // Lazy-init once: useRef(create...) allocates a discarded order+Map every render.
  const currentRef = useRef<NativeChatTranscriptOrder | null>(null)
  if (currentRef.current === null) {
    currentRef.current = createNativeChatTranscriptOrder()
  }
  const [current, setCurrent] = useState(() => readSeededTranscriptOrder(currentRef))
  const replace = useCallback(() => {
    currentRef.current = replaceNativeChatTranscriptOrder(readSeededTranscriptOrder(currentRef))
    setCurrent(currentRef.current)
  }, [])
  const append = useCallback((messages: readonly NativeChatMessage[], retainedCount: number) => {
    currentRef.current = appendNativeChatTranscriptOrder(
      readSeededTranscriptOrder(currentRef),
      messages,
      retainedCount
    )
    setCurrent(currentRef.current)
  }, [])
  const settle = useCallback((messages: readonly NativeChatMessage[], retainedCount: number) => {
    currentRef.current = settleNativeChatTranscriptOrder(
      readSeededTranscriptOrder(currentRef),
      messages,
      retainedCount
    )
    setCurrent(currentRef.current)
  }, [])
  return [current, replace, append, settle]
}
