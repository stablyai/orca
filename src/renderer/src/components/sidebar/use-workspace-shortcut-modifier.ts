import { useEffect, useState } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { isFloatingWorkspacePanelFocused } from '@/lib/floating-workspace-terminal-actions'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { matchKeybindingDigitIndex, type KeybindingOverrides } from '../../../../shared/keybindings'

export function useWorkspaceShortcutModifier(keybindings: KeybindingOverrides): boolean {
  const [held, setHeld] = useState(false)
  const [matching, setMatching] = useState(false)

  useEffect(() => {
    const clear = () => {
      setMatching(false)
    }
    const update = (event: KeyboardEvent) => {
      const matches =
        !event.isComposing &&
        !hasVisibleOverlay() &&
        !isFloatingWorkspacePanelFocused() &&
        matchKeybindingDigitIndex(
          'workspace.selectByIndex',
          {
            key: '1',
            code: 'Digit1',
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey
          },
          getShortcutPlatform(),
          keybindings
        ) === 0
      setMatching(matches)
    }
    window.addEventListener('keydown', update, true)
    window.addEventListener('keyup', update, true)
    window.addEventListener('blur', clear)
    window.addEventListener('focusin', clear)
    document.addEventListener('visibilitychange', clear)
    return () => {
      clear()
      window.removeEventListener('keydown', update, true)
      window.removeEventListener('keyup', update, true)
      window.removeEventListener('blur', clear)
      window.removeEventListener('focusin', clear)
      document.removeEventListener('visibilitychange', clear)
    }
  }, [keybindings])

  useEffect(() => {
    if (!matching) {
      return
    }
    const timer = setTimeout(() => setHeld(true), 250)
    return () => {
      clearTimeout(timer)
      setHeld(false)
    }
  }, [matching])

  return matching && held
}
