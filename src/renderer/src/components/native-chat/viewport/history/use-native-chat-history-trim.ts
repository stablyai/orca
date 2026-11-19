import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  boundNativeChatWindow,
  replaceList,
  type NativeChatMerger
} from '../../../../../../shared/native-chat/transcript/streaming/native-chat-merge'
import type { ReadState } from '../../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatSessionTransport } from '../../session/terminal/read/native-chat-session-transport'
import { NATIVE_CHAT_INITIAL_LIMIT } from './native-chat-pagination'

/** Returns the held window to its initial size when the reader goes back to the latest rows. */
export function useNativeChatHistoryTrim({
  sessionId,
  transport,
  read,
  appendMergerRef,
  limitRef,
  latestEnabled,
  latestSessionId,
  latestTransport,
  transcriptEpochRef,
  setOlderHistoryGeneration,
  setLoadingEarlier,
  setRead,
  setAppended,
  setHasMore
}: {
  sessionId: string | null
  transport: NativeChatSessionTransport
  read: ReadState
  appendMergerRef: RefObject<NativeChatMerger>
  limitRef: RefObject<number>
  latestEnabled: RefObject<boolean>
  latestSessionId: RefObject<string | null>
  latestTransport: RefObject<NativeChatSessionTransport>
  transcriptEpochRef: RefObject<number>
  setOlderHistoryGeneration: Dispatch<SetStateAction<number>>
  setLoadingEarlier: Dispatch<SetStateAction<boolean>>
  setRead: Dispatch<SetStateAction<ReadState>>
  setAppended: Dispatch<SetStateAction<NativeChatMessage[]>>
  setHasMore: Dispatch<SetStateAction<boolean>>
}): () => void {
  return useCallback(() => {
    if (
      !latestEnabled.current ||
      latestSessionId.current !== sessionId ||
      latestTransport.current !== transport
    ) {
      return
    }
    limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
    // Retire pagination without closing the independently owned live stream.
    transcriptEpochRef.current += 1
    setOlderHistoryGeneration(transcriptEpochRef.current)
    setLoadingEarlier(false)
    const merger = appendMergerRef.current
    const bounded = boundNativeChatWindow(merger.list, NATIVE_CHAT_INITIAL_LIMIT)
    const trimmedAppend = bounded !== merger.list
    setRead((current) => {
      if (current.phase !== 'ready') {
        return current
      }
      // Evict the base too when the append prefix is gone, keeping one contiguous suffix.
      const messages = trimmedAppend
        ? []
        : boundNativeChatWindow(current.messages, NATIVE_CHAT_INITIAL_LIMIT)
      return messages === current.messages ? current : { ...current, messages }
    })
    if (trimmedAppend) {
      replaceList(merger, bounded)
      setAppended(merger.list)
    }
    if (
      (read.phase === 'ready' && read.messages.length > NATIVE_CHAT_INITIAL_LIMIT) ||
      trimmedAppend
    ) {
      setHasMore(true)
    }
  }, [
    read,
    sessionId,
    transport,
    appendMergerRef,
    limitRef,
    latestEnabled,
    latestSessionId,
    latestTransport,
    transcriptEpochRef,
    setOlderHistoryGeneration,
    setLoadingEarlier,
    setRead,
    setAppended,
    setHasMore
  ])
}
