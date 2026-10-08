import { useLayoutEffect, type RefObject } from 'react'
import { NATIVE_CHAT_ROOT_SELECTOR } from '@/lib/native-chat-paste-request'

/** Whether `element` is nothing in particular (the body) or inside the chat pane holding `card`. */
export function isInNativeChatPaneOf(card: HTMLElement | null, element: Element | null): boolean {
  return (
    !element ||
    element === document.body ||
    Boolean(card?.closest(NATIVE_CHAT_ROOT_SELECTOR)?.contains(element))
  )
}

/**
 * Focus a prompt card when it takes the input region, in the same commit, so keys leave this
 * pane's hidden composer at once. Never takes focus from another surface the user is in, nor
 * from a control inside the card. `step` re-runs it when the card swaps its content, which
 * drops focus to the body if the focused control was replaced.
 */
export function useNativeChatPromptCardFocus(
  cardRef: RefObject<HTMLElement | null>,
  shouldFocus: boolean,
  step?: number
): void {
  useLayoutEffect(() => {
    const card = cardRef.current
    const active = document.activeElement
    if (shouldFocus && isInNativeChatPaneOf(card, active) && !card?.contains(active)) {
      card?.focus()
    }
  }, [cardRef, shouldFocus, step])
}
