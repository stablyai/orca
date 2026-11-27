import { useEffect, type RefObject } from 'react'

/** Sonner measures a toast only when it is shown, so a card that grows in place must be re-shown to stay inside its box. */
export function useToastHeightChange(
  ref: RefObject<HTMLElement | null>,
  onHeightChange: (() => void) | undefined
): void {
  useEffect(() => {
    const element = ref.current
    if (!element || !onHeightChange) {
      return
    }
    let height = element.offsetHeight
    const observer = new ResizeObserver(() => {
      if (element.offsetHeight !== height) {
        height = element.offsetHeight
        onHeightChange()
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, onHeightChange])
}
