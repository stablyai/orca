import type { KeyboardEvent } from 'react'

/** Escape backs out; the card opens focused on itself so no keystroke can approve, and Tab from it
 * enters on the first answer instead of the header's Cancel. */
export function handleApprovalCardKeyDown(
  event: KeyboardEvent<HTMLElement>,
  actions: HTMLElement | null,
  escape: (() => void) | undefined
): void {
  if (event.key === 'Escape' && !event.nativeEvent.isComposing && escape) {
    event.preventDefault()
    event.stopPropagation()
    escape()
    return
  }
  if (
    event.key !== 'Tab' ||
    event.target !== event.currentTarget ||
    event.shiftKey ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  ) {
    return
  }
  const first = actions?.querySelector<HTMLButtonElement>(
    '[data-native-chat-approval-answer]:not(:disabled)'
  )
  if (first) {
    event.preventDefault()
    first.focus()
  }
}
