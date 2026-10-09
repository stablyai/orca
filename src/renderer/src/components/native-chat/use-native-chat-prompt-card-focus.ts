import { useLayoutEffect, type RefObject } from 'react'
import { NATIVE_CHAT_ROOT_SELECTOR } from '@/lib/native-chat-paste-request'

/** A prompt card marks itself with this while it wants focus (`shouldFocus`). */
const PROMPT_CARD_WANTS_FOCUS_SELECTOR = '[data-native-chat-prompt-card-focus]'

/** Hands focus to the pane's shown prompt card that wants it, as the card would have taken it
 *  had focus been free; false when there is none or `keep` is already a control inside it. */
export function focusNativeChatPromptCard(root: Element, keep: Element | null): boolean {
  const card = Array.from(
    root.querySelectorAll<HTMLElement>(PROMPT_CARD_WANTS_FOCUS_SELECTOR)
  ).find((candidate) => !candidate.closest('[hidden], [inert]'))
  if (!card || card.contains(keep)) {
    return false
  }
  card.focus()
  return true
}

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
    // The pane's find bar is a surface of its own: a card arriving mid-query does not take its keys.
    if (
      shouldFocus &&
      isInNativeChatPaneOf(card, active) &&
      !card?.contains(active) &&
      !active?.closest('[data-native-chat-find-bar]')
    ) {
      card?.focus()
    }
  }, [cardRef, shouldFocus, step])
}
