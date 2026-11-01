import { useEffect } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useAppStore } from '@/store'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../../../shared/modifier-double-tap-detector'

/** The pop-out has no Window menu or tab routing, so its close-tab chord closes the window. */
export function useDashboardPopoutCloseShortcut(): void {
  useEffect(() => {
    const platform = getShortcutPlatform()
    const detector = new ModifierDoubleTapDetector()
    const onInput = (event: KeyboardEvent): void => {
      // The terminal preview dialog owns this chord: it closes the dialog or reaches the shell.
      if (
        event.defaultPrevented ||
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
