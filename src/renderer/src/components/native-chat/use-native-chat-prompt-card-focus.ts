import { useLayoutEffect, type RefObject } from 'react'

/**
 * Focus a prompt card when it takes the input region, in the same commit, so keys leave this
 * pane's hidden composer at once. Never takes focus from another surface the user is in.
 */
export function useNativeChatPromptCardFocus(
  cardRef: RefObject<HTMLElement | null>,
  shouldFocus: boolean
): void {
  useLayoutEffect(() => {
    const card = cardRef.current
    const active = document.activeElement
    const fromThisPane =
      !active ||
      active === document.body ||
      card?.closest('[data-native-chat-root]')?.contains(active)
    if (shouldFocus && fromThisPane) {
      card?.focus()
    }
  }, [cardRef, shouldFocus])
}
