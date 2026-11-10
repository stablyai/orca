import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { textFieldClaimsActionKey } from '@/lib/file-search-shortcut-policy'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../../../../../shared/modifier-double-tap-detector'

const ACTION_ID = 'sidebar.projects.toggleCollapse'

function canToggleProjects(): boolean {
  return (
    useAppStore.getState().activeModal === 'none' &&
    !hasVisibleOverlay({ ignoreMatches: '[data-contextual-tour-panel="projects-collapse-all"]' }) &&
    !document.querySelector('[data-shortcut-recorder-active]')
  )
}

export function useProjectsCollapseShortcut(enabled: boolean, onToggle: () => void): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    const doubleTapDetector = new ModifierDoubleTapDetector()
    const processDoubleTap = (event: KeyboardEvent) =>
      doubleTapDetector.process(
        toModifierDoubleTapEvent({
          type: event.type === 'keydown' ? 'keyDown' : 'keyUp',
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
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.key === 'Process' ||
        event.getModifierState('AltGraph')
      ) {
        return
      }
      const detected = processDoubleTap(event)
      const input = detected ? { doubleTapModifier: detected.modifier } : event
      const { keybindings, settings } = useAppStore.getState()
      const platform = getShortcutPlatform()
      const context =
        event.target instanceof HTMLElement &&
        event.target.classList.contains('xterm-helper-textarea')
          ? 'terminal'
          : 'app'
      const terminalShortcutPolicy = settings?.terminalShortcutPolicy
      if (
        !keybindingMatchesAction(ACTION_ID, input, platform, keybindings, {
          context,
          terminalShortcutPolicy
        }) ||
        textFieldClaimsActionKey(event, ACTION_ID) ||
        !canToggleProjects()
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (context === 'terminal' && (terminalShortcutPolicy ?? 'orca-first') === 'orca-first') {
        showTerminalShortcutCaptureNotification({ actionId: ACTION_ID, platform, keybindings })
      }
      onToggle()
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      processDoubleTap(event)
    }
    const onBlur = (): void => doubleTapDetector.reset()
    addAppKeyListener('keydown', onKeyDown)
    addAppKeyListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    const unsubscribeGuestShortcut = window.api.ui.onToggleProjectsCollapse?.(() => {
      if (canToggleProjects()) {
        onToggle()
      }
    })
    return () => {
      unsubscribeGuestShortcut?.()
      removeAppKeyListener('keydown', onKeyDown)
      removeAppKeyListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [enabled, onToggle])
}
