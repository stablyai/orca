import { useEffect } from 'react'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'
import { useAppStore } from '@/store'
import { keybindingMatchesAction } from '../../../../shared/keybindings/matching'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../../../shared/keybindings/modifier-double-tap-detector'
import {
  nativeChatPromptClaimsShortcut,
  textInputOwnsComposition
} from '../../../../shared/keybindings/text-input-shortcut-policy'

/** The pop-out has no Window menu or tab routing, so its close-tab chord closes the window. */
export function useDashboardPopoutCloseShortcut(): void {
  useEffect(() => {
    const platform = getShortcutPlatform()
    const detector = new ModifierDoubleTapDetector()
    const onInput = (event: KeyboardEvent): void => {
      // Let text inputs, IME composition, and the terminal preview dialog handle their own keys first.
      if (
        event.defaultPrevented ||
        textInputOwnsComposition(event) ||
        (isEditableTarget(event.target) &&
          nativeChatPromptClaimsShortcut(event, platform, 'tab.close')) ||
        (event.target instanceof Element && event.target.closest('[role="dialog"]'))
      ) {
        detector.reset()
        return
      }
      const detected = detector.process(
        toModifierDoubleTapEvent({
          type: event.type === 'keyup' ? 'keyUp' : 'keyDown',
          key: event.key,
          code: event.code,
          meta: event.metaKey,
          control: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey,
          isAutoRepeat: event.repeat
        }),
        Date.now()
      )
      if (
        event.type === 'keydown' &&
        !event.repeat &&
        keybindingMatchesAction(
          'tab.close',
          detected ? { doubleTapModifier: detected.modifier } : event,
          platform,
          useAppStore.getState().keybindings
        )
      ) {
        event.preventDefault()
        window.close()
      }
    }
    const reset = (): void => detector.reset()
    window.addEventListener('keydown', onInput)
    window.addEventListener('keyup', onInput)
    window.addEventListener('blur', reset)
    window.addEventListener('focusin', reset)
    return () => {
      window.removeEventListener('keydown', onInput)
      window.removeEventListener('keyup', onInput)
      window.removeEventListener('blur', reset)
      window.removeEventListener('focusin', reset)
    }
  }, [])
}
