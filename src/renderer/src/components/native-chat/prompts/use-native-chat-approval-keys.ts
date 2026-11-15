import { useEffect, useEffectEvent, type RefObject } from 'react'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'
import type { ChatApproval } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { isInNativeChatPaneOf } from './use-native-chat-prompt-card-focus'

export function useNativeChatApprovalKeys({
  cardRef,
  enabled,
  options,
  onChooseOption
}: {
  cardRef: RefObject<HTMLElement | null>
  enabled: boolean
  options: ChatApproval['options']
  onChooseOption: (optionSend: string) => void
}): void {
  const onKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    const target = event.target instanceof Element ? event.target : null
    const card = cardRef.current
    const isNumberKey = /^[1-9]$/.test(event.key)
    const isArrow = event.key === 'ArrowDown' || event.key === 'ArrowUp'
    const field = card?.querySelector<HTMLTextAreaElement>('[data-native-chat-answer-field]')
    const inField = field != null && target === field
    if (
      event.defaultPrevented ||
      (isEditableTarget(target) && !(inField && isArrow)) ||
      target?.closest('[data-native-chat-find-bar], [data-queued-message-editor]') ||
      (!card?.contains(target) && !isInNativeChatPaneOf(card, target)) ||
      (!isNumberKey && !card?.contains(target))
    ) {
      return
    }
    if (
      event.repeat ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      (event.shiftKey && !isNumberKey)
    ) {
      return
    }
    if (isNumberKey) {
      const chosen = options[Number(event.key) - 1]
      if (!chosen) {
        return
      }
      event.preventDefault()
      onChooseOption(chosen.send)
      return
    }
    if (isArrow) {
      const up = event.key === 'ArrowUp'
      const rows = Array.from(
        card?.querySelectorAll<HTMLButtonElement>('[data-native-chat-approval-option]') ?? []
      )
      if (
        rows.length === 0 ||
        (inField &&
          (field.selectionStart !== field.selectionEnd ||
            field.selectionStart !== (up ? 0 : field.value.length)))
      ) {
        return
      }
      const focusedIndex = rows.findIndex((row) => row.contains(target))
      const stops: HTMLElement[] = field ? [...rows, field] : rows
      const current = inField ? stops.length - 1 : focusedIndex
      const nextIndex =
        current === -1
          ? up
            ? stops.length - 1
            : 0
          : (current + (up ? -1 : 1) + stops.length) % stops.length
      event.preventDefault()
      const next = stops[nextIndex]
      next?.focus()
      if (field && next === field) {
        field.setSelectionRange(field.value.length, field.value.length)
      }
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
