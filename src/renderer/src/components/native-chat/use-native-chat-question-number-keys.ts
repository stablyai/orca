import { useEffect, useEffectEvent, type RefObject } from 'react'
import { isEditableTarget } from '@/lib/editable-target'
import { isInNativeChatPaneOf } from './use-native-chat-prompt-card-focus'

/**
 * Digits 1–9 pick the option with that number while the card owns its pane's keyboard.
 * Listens on the document because focus falls to the body when a focused row is replaced;
 * keys aimed at a text field or at another surface are left alone.
 */
export function useNativeChatQuestionNumberKeys(
  cardRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  optionCount: number,
  onPick: (optionIndex: number) => void
): void {
  const onKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      !/^[1-9]$/.test(event.key)
    ) {
      return
    }
    const optionIndex = Number(event.key) - 1
    const target = event.target instanceof Element ? event.target : null
    if (
      optionIndex >= optionCount ||
      isEditableTarget(target) ||
      !isInNativeChatPaneOf(cardRef.current, target)
    ) {
      return
    }
    event.preventDefault()
    onPick(optionIndex)
  })
  useEffect(() => {
    if (!enabled) {
      return
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
