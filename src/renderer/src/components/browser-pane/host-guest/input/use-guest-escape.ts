import { useEffect, useEffectEvent } from 'react'

/** Escape typed in the focused page never reaches the renderer; main hands it back per page. */
export function useGuestEscape(
  browserPageId: string,
  enabled: boolean,
  onEscape: () => void
): void {
  const handleEscape = useEffectEvent(onEscape)
  useEffect(() => {
    if (!enabled) {
      return
    }
    return window.api.browser.onGuestEscape((event) => {
      if (event.browserPageId === browserPageId) {
        handleEscape()
      }
    })
  }, [browserPageId, enabled])
}
