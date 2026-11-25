// The open item's chords, through the app keyboard router (ahead of the comment editor): Back, and the
// previous / next item. Only from inside the pane, never a portaled layer or a key an IME owns.
import { useEffect, type RefObject } from 'react'
import { useAppStore } from '@/store'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { keybindingMatchesAction } from '../../../../../shared/keybindings/matching'
import {
  shortcutProducesText,
  textInputOwnsComposition
} from '../../../../../shared/keybindings/text-input-shortcut-policy'
import type { BotItemStepDirection } from './BotItemStepper'

/** What had focus when a step started: an arrow, the comment editor, or something else. */
export type BotItemStepOrigin = BotItemStepDirection | 'editor' | null

export function useBotItemChords(
  root: RefObject<HTMLDivElement | null>,
  handlers: { back: () => void; step: (direction: 1 | -1, from: BotItemStepOrigin) => void }
): void {
  const back = useLatestHandler(handlers.back)
  const step = useLatestHandler(handlers.step)
  useEffect(() => {
    const platform = getShortcutPlatform()
    const onKeyDown = (event: KeyboardEvent): void => {
      const node = root.current
      const target = event.target
      if (
        event.defaultPrevented ||
        isImeOwnedKeyboardEvent(event) ||
        !node ||
        !(target instanceof Node) ||
        !node.contains(target)
      ) {
        return
      }
      const keybindings = useAppStore.getState().keybindings
      if (keybindingMatchesAction('botItem.back', event, platform, keybindings)) {
        event.preventDefault()
        event.stopPropagation()
        if (!event.repeat) {
          back()
        }
        return
      }
      const direction = keybindingMatchesAction('botItem.next', event, platform, keybindings)
        ? 1
        : keybindingMatchesAction('botItem.previous', event, platform, keybindings)
          ? -1
          : null
      // A rebound chord that types a character types it where text goes; elsewhere in the pane it steps.
      if (
        direction === null ||
        textInputOwnsComposition(event) ||
        (shortcutProducesText(event, platform) && isEditableTarget(target))
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) {
        step(direction, stepOrigin(target))
      }
    }
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [back, root, step])
}

function stepOrigin(target: EventTarget): BotItemStepOrigin {
  if (!(target instanceof Element)) {
    return null
  }
  const arrow = target.getAttribute('data-bot-item-step')
  if (arrow === 'next' || arrow === 'previous') {
    return arrow
  }
  // Typing a comment, or an answer in the open question's card that stands in for the comment box.
  return isEditableTarget(target) &&
    (target.closest('[data-native-chat-composer-scope]') ||
      target.hasAttribute('data-native-chat-answer-field'))
    ? 'editor'
    : null
}
