import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { isEditableTarget } from '@/lib/editable-target'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { isXtermHelperTextarea } from '@/components/terminal-pane/regular-terminal-focus-ownership'

/** `sessions.grid.nextPage` / `sessions.grid.prevPage` move the grid one row or page. */
export function useSessionGridKeyboardNavigation(args: {
  currentPositionRef: React.RefObject<number>
  scrollToPosition: (targetIndex: number) => void
}): void {
  const { currentPositionRef, scrollToPosition } = args
  const keybindings = useAppStore((s) => s.keybindings)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Why no repeat: holding the key queued smooth scrolls that fought each other.
      if (e.repeat || e.defaultPrevented) {
        return
      }
      // Guarded on the event target, not activeElement: a PageDown typed into a card's
      // live terminal is that terminal's scrollback, and isEditableTarget lets xterm through.
      if (isXtermHelperTextarea(e.target) || isEditableTarget(e.target)) {
        return
      }
      const platform = getShortcutPlatform()
      const step = keybindingMatchesAction('sessions.grid.nextPage', e, platform, keybindings)
        ? 1
        : keybindingMatchesAction('sessions.grid.prevPage', e, platform, keybindings)
          ? -1
          : 0
      if (step === 0) {
        return
      }
      e.preventDefault()
      scrollToPosition((currentPositionRef.current ?? 0) + step)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [currentPositionRef, keybindings, scrollToPosition])
}
