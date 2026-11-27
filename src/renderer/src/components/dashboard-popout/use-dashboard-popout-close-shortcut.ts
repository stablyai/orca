import { useEffect } from 'react'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { useAppStore } from '@/store'
import { terminalDialogIsOpen } from './snapshot/useDashboardSnapshot'
import { keybindingMatchesAction } from '../../../../shared/keybindings/matching'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../../../shared/keybindings/modifier-double-tap-detector'
import { textInputOwnsComposition } from '../../../../shared/keybindings/text-input-shortcut-policy'

/** The pop-out has no Window menu or tab routing, so its close-tab chord closes the window. */
export function useDashboardPopoutCloseShortcut(): void {
  useEffect(() => {
    const platform = getShortcutPlatform()
    const doubleTapDetector = new ModifierDoubleTapDetector()
    const detectDoubleTap = (event: KeyboardEvent) => {
      if (textInputOwnsComposition(event)) {
        doubleTapDetector.reset()
        return null
      }
      return doubleTapDetector.process(
        toModifierDoubleTapEvent({
          type: event.type === 'keyup' ? 'keyUp' : 'keyDown',
          code: event.code,
          key: event.key,
          shift: event.shiftKey,
          control: event.ctrlKey,
          alt: event.altKey,
          meta: event.metaKey,
          isAutoRepeat: event.repeat
        }),
        Date.now()
      )
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const detected = detectDoubleTap(event)
      // An open dialog owns this chord even before focus moves into it; a held chord must not close the window behind a just-closed dialog.
      if (
        event.defaultPrevented ||
        event.repeat ||
        textInputOwnsComposition(event) ||
        !keybindingMatchesAction(
          'tab.close',
          detected ? { doubleTapModifier: detected.modifier } : event,
          platform,
          useAppStore.getState().keybindings
        ) ||
        terminalDialogIsOpen()
      ) {
        return
      }
      event.preventDefault()
      window.close()
    }
    const onBlur = (): void => doubleTapDetector.reset()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', detectDoubleTap)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', detectDoubleTap)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
}
