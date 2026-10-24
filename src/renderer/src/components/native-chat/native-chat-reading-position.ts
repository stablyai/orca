import { useMemo } from 'react'
import {
  createNativeChatReturnField,
  useNativeChatReturnRef
} from './native-chat-view-state-memory'

export type NativeChatReadingPosition = {
  followingEnd: boolean
  anchor: { rowKey: string; offsetWithinRow: number; epoch?: string; sequence?: number } | null
}
const readingPosition = createNativeChatReturnField<NativeChatReadingPosition>()
export function useNativeChatReadingPosition() {
  return useNativeChatReturnRef(readingPosition, () => ({ followingEnd: true, anchor: null }))
}

export function useNativeChatFollowingEnd() {
  const readingPosition = useNativeChatReadingPosition()
  return useMemo(
    () => ({
      get current() {
        return readingPosition.current.followingEnd
      },
      set current(followingEnd: boolean) {
        readingPosition.current = { ...readingPosition.current, followingEnd }
      }
    }),
    [readingPosition]
  )
}
