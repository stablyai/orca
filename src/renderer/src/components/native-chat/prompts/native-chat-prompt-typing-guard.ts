import { isEditableTarget } from '@/lib/text-input/focus/editable-target'

/** Keys closer together than this are one typing burst. */
const TYPING_GAP_MS = 1000

let lastTypedAt = Number.NEGATIVE_INFINITY
let lastKeyAt = Number.NEGATIVE_INFINITY
let previousKeyAt = Number.NEGATIVE_INFINITY
const guardedCards = new WeakSet<HTMLElement>()

if (typeof document !== 'undefined') {
  document.addEventListener(
    'keydown',
    (event) => {
      previousKeyAt = lastKeyAt
      lastKeyAt = event.timeStamp
      // Only text typed into a field arms the guard; Tab, arrows and modifiers do not.
      if (
        isEditableTarget(event.target) &&
        (event.key.length === 1 || event.key === 'Enter' || event.key === 'Backspace')
      ) {
        lastTypedAt = event.timeStamp
      }
    },
    { capture: true, passive: true }
  )
}

/** Called as a card moves focus onto an answer: a burst still going must not pick it. */
export function guardPromptCardAgainstTyping(card: HTMLElement): void {
  if (performance.now() - lastTypedAt < TYPING_GAP_MS) {
    guardedCards.add(card)
  } else {
    guardedCards.delete(card)
  }
}

/** True when Enter or Space continues the burst that was going as the card took focus. */
export function isTypedIntoPromptCard(card: HTMLElement, event: KeyboardEvent): boolean {
  if (!guardedCards.has(card)) {
    return false
  }
  if (event.timeStamp - previousKeyAt >= TYPING_GAP_MS) {
    guardedCards.delete(card)
    return false
  }
  // The burst goes on here, so a card that replaces this one is guarded too.
  lastTypedAt = event.timeStamp
  return event.key === 'Enter' || event.key === ' '
}
