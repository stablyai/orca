import { useCallback, useSyncExternalStore, type KeyboardEvent } from 'react'
import {
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft
} from '../drafts/native-chat-composer-draft-store'

const ANSWER_SELECTOR = '[data-native-chat-approval-answer]:not(:disabled)'

/** Live, so a card kept mounted while folded sees text typed before it is reopened. */
export function useComposerHoldsText(scopeKey: string | undefined): boolean {
  const subscribe = useCallback(
    (listener: () => void) =>
      scopeKey === undefined ? () => {} : subscribeToNativeChatComposerDraft(scopeKey, listener),
    [scopeKey]
  )
  return useSyncExternalStore(
    subscribe,
    () => scopeKey !== undefined && readNativeChatComposerDraft(scopeKey).text !== ''
  )
}

/** ←/→ step between the card's answers, wrapping; from the card itself, Tab and ←/→ enter on the first. */
function stepAnswerFocus(
  actions: HTMLElement | null,
  event: KeyboardEvent<HTMLElement>,
  delta: 1 | -1
): boolean {
  const answers = Array.from(actions?.querySelectorAll<HTMLButtonElement>(ANSWER_SELECTOR) ?? [])
  if (event.target === event.currentTarget) {
    answers[0]?.focus()
    return answers.length > 0
  }
  const current = event.target instanceof HTMLButtonElement ? answers.indexOf(event.target) : -1
  if (current === -1) {
    return false
  }
  answers[(current + delta + answers.length) % answers.length]?.focus()
  return true
}

/** Escape backs out of the approval card; ←/→ move between its answers as Tab does. */
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
  if (
    event.key.length === 1 &&
    event.key !== ' ' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.target !== event.currentTarget
  ) {
    // Typing meant for the message box: step off the answer so the next space cannot approve.
    event.currentTarget.focus()
    return
  }
  const steps =
    event.key === 'ArrowLeft' ||
    event.key === 'ArrowRight' ||
    // A card opened without a focused answer: Tab enters on the first answer, not the header's Cancel.
    (event.key === 'Tab' && event.target === event.currentTarget)
  if (
    steps &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    stepAnswerFocus(actions, event, event.key === 'ArrowLeft' ? -1 : 1)
  ) {
    event.preventDefault()
  }
}
