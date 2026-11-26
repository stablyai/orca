import { createContext, useCallback, useMemo, type RefObject } from 'react'

export type NativeChatToolRunScroll = {
  canAdjustToolRunScroll: () => boolean
  adjustToolRunScroll: (delta: number) => void
  readerLeavesEnd: () => void
}

export const NativeChatTranscriptScrollContext = createContext<NativeChatToolRunScroll | null>(null)

export function useNativeChatToolRunScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  isVisible: boolean,
  {
    isAlignPending,
    markProgrammaticScroll
  }: {
    isAlignPending?: () => boolean
    markProgrammaticScroll: (offset: number) => void
  },
  {
    isFollowingEnd,
    readerLeavesEnd
  }: {
    isFollowingEnd: () => boolean
    readerLeavesEnd: () => void
  }
): NativeChatToolRunScroll {
  const canAdjustToolRunScroll = useCallback(
    () => isVisible && !isFollowingEnd() && !isAlignPending?.(),
    [isAlignPending, isFollowingEnd, isVisible]
  )
  const adjustToolRunScroll = useCallback(
    (delta: number) => {
      const element = scrollRef.current
      if (element && canAdjustToolRunScroll()) {
        const previous = element.scrollTop
        element.scrollTop += delta
        if (element.scrollTop !== previous) {
          markProgrammaticScroll(element.scrollTop)
        }
      }
    },
    [canAdjustToolRunScroll, markProgrammaticScroll, scrollRef]
  )
  return useMemo(
    () => ({ canAdjustToolRunScroll, adjustToolRunScroll, readerLeavesEnd }),
    [adjustToolRunScroll, canAdjustToolRunScroll, readerLeavesEnd]
  )
}
