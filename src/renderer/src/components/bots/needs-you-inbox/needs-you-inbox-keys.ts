// What a key pressed on the inbox's list does. Plain keys only: never with a modifier, while an IME
// composes, or in a text field, so typing a reply never moves or answers anything; and never a held
// key's repeats, except to move.
import type React from 'react'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'

export type NeedsYouInboxKey =
  | { kind: 'step'; direction: 1 | -1 }
  | { kind: 'group' }
  | { kind: 'answer'; digit: number }
  | { kind: 'reply' }
  | { kind: 'open' }
  | { kind: 'done' }
  | { kind: 'snooze' }

const LETTERS: Record<string, NeedsYouInboxKey> = {
  j: { kind: 'step', direction: 1 },
  ArrowDown: { kind: 'step', direction: 1 },
  k: { kind: 'step', direction: -1 },
  ArrowUp: { kind: 'step', direction: -1 },
  g: { kind: 'group' },
  // I, as Vim's insert, to write in the item's comment box; R stays as an alias.
  i: { kind: 'reply' },
  r: { kind: 'reply' },
  Enter: { kind: 'open' },
  e: { kind: 'done' },
  s: { kind: 'snooze' }
}

export function needsYouInboxKey(event: React.KeyboardEvent): NeedsYouInboxKey | null {
  if (
    event.defaultPrevented ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    isImeOwnedKeyboardEvent(event.nativeEvent) ||
    isEditableTarget(event.target)
  ) {
    return null
  }
  const key: NeedsYouInboxKey | null = /^[1-9]$/.test(event.key)
    ? { kind: 'answer', digit: Number(event.key) }
    : Object.hasOwn(LETTERS, event.key)
      ? LETTERS[event.key]!
      : null
  // A held key only keeps moving: held E or 1 would act on each row that takes the place of the last.
  return event.repeat && key?.kind !== 'step' ? null : key
}

/** Escape in the item's comment box is the box's own while it holds words or a suggestion list is
 *  open (it closes the list, or keeps the draft), as on the Items tab. */
export function escapeStaysInComposer(target: Element): boolean {
  return (
    (target.textContent ?? '').trim() !== '' ||
    document.querySelector('[data-focus-behavior="composer-suggestions"]') !== null
  )
}
