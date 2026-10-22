import { useEffect, useEffectEvent, type RefObject } from 'react'
import { isEditableTarget } from '@/lib/editable-target'
import { isInNativeChatPaneOf } from './use-native-chat-prompt-card-focus'

/** Keep question shortcuts scoped to its pane, including when a replaced row drops focus. */
export function useNativeChatQuestionKeys(
  cardRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  optionCount: number,
  onPick: (optionIndex: number) => void
): void {
  const onKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    const target = event.target instanceof Element ? event.target : null
    const card = cardRef.current
    const isNumberKey = /^[1-9]$/.test(event.key)
    if (
      event.defaultPrevented ||
      isEditableTarget(target) ||
      target?.closest('[data-native-chat-find-bar], [data-queued-message-editor]') ||
      !isInNativeChatPaneOf(card, target) ||
      (!isNumberKey && !card?.contains(target))
    ) {
      return
    }
    const rows = Array.from(card?.querySelectorAll<HTMLButtonElement>('button[aria-pressed]') ?? [])
    const focusedIndex = rows.findIndex((row) => row.contains(target))
    if (
      event.repeat ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      (event.shiftKey && !isNumberKey)
    ) {
      // Prevent the button's native Enter click from bypassing the shortcut guard.
      if (event.key === 'Enter' && focusedIndex !== -1) {
        event.preventDefault()
      }
      return
    }
    if (isNumberKey) {
      const optionIndex = Number(event.key) - 1
      if (optionIndex >= optionCount) {
        return
      }
      event.preventDefault()
      onPick(optionIndex)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rows.length === 0) {
        return
      }
      const nextIndex =
        focusedIndex === -1
          ? event.key === 'ArrowDown'
            ? 0
            : rows.length - 1
          : (focusedIndex + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
      event.preventDefault()
      rows[nextIndex]?.focus()
    } else if (event.key === 'Enter' && focusedIndex !== -1) {
      event.preventDefault()
      onPick(focusedIndex)
    }
  })
  useEffect(() => {
    if (!enabled) {
      return
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
