import { useCallback, type RefObject } from 'react'

export function useNativeChatRowNavigation(
  rowRef: RefObject<HTMLDivElement | null>,
  onScrollMessageToTop: (element: HTMLElement) => void
): { scrollToTop: () => void; returnToView: () => void } {
  const scrollToTop = useCallback(() => {
    if (rowRef.current) {
      onScrollMessageToTop(rowRef.current)
    }
  }, [onScrollMessageToTop, rowRef])
  // Folding from a prompt's bottom can leave the reader past its new end.
  const returnToView = useCallback(() => {
    const row = rowRef.current
    const viewport = row?.closest('[data-native-chat-scroll]')
    if (row && viewport && row.getBoundingClientRect().top < viewport.getBoundingClientRect().top) {
      onScrollMessageToTop(row)
    }
  }, [onScrollMessageToTop, rowRef])
  return { scrollToTop, returnToView }
}
