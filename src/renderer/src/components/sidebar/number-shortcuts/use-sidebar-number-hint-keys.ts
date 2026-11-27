import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { selectWorkspaceListOpen } from '@/components/app-rail/app-rail-layout'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { shortcutPlatform } from '../../../app-shell/chrome/app-window-chrome'
import { holdsDigitIndexModifiers } from '../../../../../shared/keybindings/digit-index-modifier-hold'
import { DIGIT_INDEX_ACTION_ID } from '../../worktree-jump/worktree-jump-palette-model'
import {
  hideSidebarNumberHints,
  showSidebarNumberHints,
  sidebarNumberHintsShown
} from './sidebar-number-hints'

// Long enough that a quick Cmd/Ctrl+digit or Cmd/Ctrl+C never flashes the numbers.
const HINT_DELAY_MS = 400
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift'])

/** Same gates the jump itself passes (workspace-shortcut-ipc-bridge), so a shown number always acts. */
function canShowHints(): boolean {
  const state = useAppStore.getState()
  // A hidden list has no rows to number.
  if (
    !selectWorkspaceListOpen(state) ||
    state.activeView !== 'terminal' ||
    state.activeModal === 'worktree-palette'
  ) {
    return false
  }
  // A focused floating panel routes the digits to its own tabs.
  const focused = document.activeElement
  return !(focused instanceof Element && focused.closest('[data-floating-terminal-panel]'))
}

/** Shows sidebar row numbers while the workspace 1–9 shortcut's modifiers are held alone. */
export function useSidebarNumberHintKeys(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const cancel = (): void => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      hideSidebarNumberHints()
    }
    const holds = (event: KeyboardEvent | PointerEvent): boolean =>
      holdsDigitIndexModifiers(
        DIGIT_INDEX_ACTION_ID,
        event,
        shortcutPlatform,
        useAppStore.getState().keybindings
      )
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!MODIFIER_KEYS.has(event.key) || !holds(event)) {
        cancel()
        return
      }
      if (event.repeat || timer !== null) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        if (canShowHints()) {
          showSidebarNumberHints()
        }
      }, HINT_DELAY_MS)
    }
    // A digit's keyup after a jump keeps the numbers while the modifier is still held.
    const onKeyUp = (event: KeyboardEvent): void => {
      if (MODIFIER_KEYS.has(event.key) || !holds(event)) {
        cancel()
      }
    }
    // A release while a page has focus never reaches this window; the next pointer move carries the real state.
    const onPointerMove = (event: PointerEvent): void => {
      if ((timer !== null || sidebarNumberHintsShown()) && !holds(event)) {
        cancel()
      }
    }
    const onVisibilityChange = (): void => {
      if (document.hidden) {
        cancel()
      }
    }
    // Observes only, so it runs first and still sees keys a later owner stops.
    addAppKeyListener('keydown', onKeyDown, { first: true })
    addAppKeyListener('keyup', onKeyUp, { first: true })
    const unsubscribeConsumed = window.api.ui.onModifierChordConsumed(cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('pointerdown', cancel, { capture: true })
    window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      removeAppKeyListener('keydown', onKeyDown)
      removeAppKeyListener('keyup', onKeyUp)
      unsubscribeConsumed()
      window.removeEventListener('blur', cancel)
      window.removeEventListener('pointerdown', cancel, { capture: true })
      window.removeEventListener('pointermove', onPointerMove, { capture: true })
      document.removeEventListener('visibilitychange', onVisibilityChange)
      cancel()
    }
  }, [])
}
