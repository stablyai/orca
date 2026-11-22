import { useLayoutEffect, useRef, type RefObject } from 'react'
import { NATIVE_CHAT_ROOT_SELECTOR } from '@/components/native-chat/paste/native-chat-paste-request'
import { replacesComposerMidDraft } from './native-chat-prompt-card-draft-handoff'

const PROMPT_CARD_WANTS_FOCUS_SELECTOR = '[data-native-chat-prompt-card-focus]'
const PROMPT_CARD_FOCUS_TARGET_SELECTOR =
  '[data-native-chat-prompt-card-focus-target]:not(:disabled)'

function focusPromptCard(card: HTMLElement): void {
  const target = card.querySelector<HTMLElement>(PROMPT_CARD_FOCUS_TARGET_SELECTOR)
  // Keys typed into a draft the card replaced must not press an answer.
  if (target && !(target instanceof HTMLButtonElement && replacesComposerMidDraft(card))) {
    // A no-options card's answer field or an approval's default: show the ring even after a click.
    target.focus({ focusVisible: true })
    return
  }
  // A question card takes focus itself, so no option opens looking picked; it is the key sink.
  card.focus()
}

/** Focus the shown card requesting it unless keep already names a control inside it; return false when ineligible. */
export function focusNativeChatPromptCard(root: Element, keep: Element | null): boolean {
  const card = Array.from(
    root.querySelectorAll<HTMLElement>(PROMPT_CARD_WANTS_FOCUS_SELECTOR)
  ).find((candidate) => !candidate.closest('[hidden], [inert]'))
  if (!card || (keep !== card && card.contains(keep))) {
    return false
  }
  focusPromptCard(card)
  return true
}

export function isInNativeChatPaneOf(card: HTMLElement | null, element: Element | null): boolean {
  return (
    !element ||
    element === document.body ||
    card?.closest('.native-chat-pane-shell') === element ||
    Boolean(card?.closest(NATIVE_CHAT_ROOT_SELECTOR)?.contains(element)) ||
    // A surface outside chat that shows the card (an item page) names its own key scope.
    Boolean(card?.closest('[data-native-chat-prompt-scope]')?.contains(element))
  )
}

/** Claim focus during commit when replacing the composer/card content; preserve other surfaces and controls already inside the card. */
export function useNativeChatPromptCardFocus(
  cardRef: RefObject<HTMLElement | null>,
  shouldFocus: boolean,
  step?: number
): void {
  const previousStepRef = useRef(step)
  useLayoutEffect(() => {
    const stepChanged = previousStepRef.current !== step
    previousStepRef.current = step
    const card = cardRef.current
    const active = document.activeElement
    // Arriving cards must not steal keys from find or queued-message edits.
    if (
      card &&
      shouldFocus &&
      isInNativeChatPaneOf(card, active) &&
      (active === card || !card.contains(active) || stepChanged) &&
      !active?.closest('[data-native-chat-find-bar], [data-queued-message-editor]')
    ) {
      focusPromptCard(card)
    }
  }, [cardRef, shouldFocus, step])
}
