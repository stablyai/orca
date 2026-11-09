import { useEffect, type RefObject } from 'react'

/** Mirror chat-cover focus to main, which yields spatial chords here as it does for a focused xterm. */
export function useNativeChatCoverFocusReporting(coverRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const cover = coverRef.current
    if (!cover) {
      return
    }
    let ownsFocus = false
    const report = (focused: boolean): void => {
      ownsFocus = focused
      window.api.ui.setNativeChatCoverFocused?.(focused)
    }
    // A move inside the cover sends focusout before focusin, so main ends on the right value.
    const onFocusIn = (): void => report(true)
    const onFocusOut = (): void => report(false)
    if (cover.contains(cover.ownerDocument.activeElement)) {
      report(true)
    }
    cover.addEventListener('focusin', onFocusIn)
    cover.addEventListener('focusout', onFocusOut)
    return () => {
      cover.removeEventListener('focusin', onFocusIn)
      cover.removeEventListener('focusout', onFocusOut)
      if (ownsFocus) {
        report(false)
      }
    }
  }, [coverRef])
}
