import { useLayoutEffect, useRef, type RefObject } from 'react'
import { NATIVE_CHAT_ROOT_SELECTOR } from '@/components/native-chat/paste/native-chat-paste-request'

const PROMPT_CARD_WANTS_FOCUS_SELECTOR = '[data-native-chat-prompt-card-focus]'
const PROMPT_CARD_FOCUS_TARGET_SELECTOR =
  '[data-native-chat-prompt-card-focus-target]:not(:disabled)'
const PROMPT_CARD_OPEN_TARGET_SELECTOR = '[data-native-chat-prompt-card-open-target]:not(:disabled)'

function focusPromptCard(card: HTMLElement, opening: boolean): void {
  const field = card.querySelector<HTMLElement>(PROMPT_CARD_FOCUS_TARGET_SELECTOR)
  // An approval answer only on arrival: a restore (find, tab switch, queued edit) may carry a held Enter.
  const target =
    field ?? (opening ? card.querySelector<HTMLElement>(PROMPT_CARD_OPEN_TARGET_SELECTOR) : null)
  if (target) {
    // Show the ring even when a mouse click opened the card; don't scroll the request out of a short card.
    target.focus({ focusVisible: true, preventScroll: target !== field })
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
  focusPromptCard(card, false)
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
  const mountedRef = useRef(false)
  useLayoutEffect(() => {
    const stepChanged = previousStepRef.current !== step
    previousStepRef.current = step
    // Callers key the card per prompt, so only its mount is an arrival; a tab or group coming back is a restore.
    const arriving = !mountedRef.current
    mountedRef.current = true
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
      focusPromptCard(card, arriving)
    }
  }, [cardRef, shouldFocus, step])
}
