import { useCallback, useSyncExternalStore, type KeyboardEvent } from 'react'
import {
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft
} from '../drafts/native-chat-composer-draft-store'

const ANSWER_SELECTOR = '[data-native-chat-approval-answer]:not(:disabled)'

/** Live, so a card kept mounted while folded sees a message started before it is reopened. */
export function useComposerHoldsDraft(scopeKey: string | undefined): boolean {
  const subscribe = useCallback(
    (listener: () => void) =>
      scopeKey === undefined ? () => {} : subscribeToNativeChatComposerDraft(scopeKey, listener),
    [scopeKey]
  )
  return useSyncExternalStore(subscribe, () => {
    if (scopeKey === undefined) {
      return false
    }
    const draft = readNativeChatComposerDraft(scopeKey)
    return draft.text !== '' || draft.images.length > 0
  })
}

/** Option and AltGr characters and dead keys count; Cmd and plain Ctrl chords are shortcuts. */
function typesText(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.key === 'Dead') {
    return true
  }
  return (
    event.key.length === 1 &&
    event.key !== ' ' &&
    !event.metaKey &&
    (!event.ctrlKey || event.nativeEvent.getModifierState('AltGraph'))
  )
}

function focusAnswer(actions: HTMLElement | null, from: EventTarget, delta: 1 | -1): boolean {
  const answers = Array.from(actions?.querySelectorAll<HTMLButtonElement>(ANSWER_SELECTOR) ?? [])
  const current = from instanceof HTMLButtonElement ? answers.indexOf(from) : -1
  const next =
    current === -1 ? answers[0] : answers[(current + delta + answers.length) % answers.length]
  next?.focus()
  return next !== undefined
}

/** Escape backs out; ←/→ step between answers; Tab from the card enters on the first answer. */
export function handleApprovalCardKeyDown(
  event: KeyboardEvent<HTMLElement>,
  actions: HTMLElement | null,
  escape: (() => void) | undefined
): void {
  if (event.nativeEvent.isComposing) {
    return
  }
  if (event.key === 'Escape' && escape) {
    event.preventDefault()
    event.stopPropagation()
    escape()
    return
  }
  const onAnswer = event.target !== event.currentTarget
  if (onAnswer && event.repeat && (event.key === 'Enter' || event.key === ' ')) {
    // A key held down before the answer took focus must not press it.
    event.preventDefault()
    return
  }
  if (onAnswer && typesText(event)) {
    // Typing meant for the message box: step off the answer so the next space cannot approve.
    event.currentTarget.focus()
    return
  }
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return
  }
  const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : null
  // From the card itself only Tab enters: an arrow there may be meant for a message caret.
  const entersFromCard = !onAnswer && event.key === 'Tab'
  if (
    ((onAnswer && delta !== null) || entersFromCard) &&
    focusAnswer(actions, onAnswer ? event.target : event.currentTarget, delta ?? 1)
  ) {
    event.preventDefault()
  }
}
