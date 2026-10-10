import { useAppStore } from '@/store'
import { buildNativeTerminalForwardedChords } from '../../../../../shared/native-terminal-forwarded-chords'

let unsubscribe: (() => void) | null = null

function pushForwardedChords(): void {
  const state = useAppStore.getState()
  window.api?.nativeTerminal?.setForwardedChords(
    buildNativeTerminalForwardedChords({
      overrides: state.keybindings,
      terminalShortcutPolicy: state.settings?.terminalShortcutPolicy
    })
  )
}

// The native view decides at keyDown whether a chord is Orca's, so it needs the chords Orca's
// shortcut handlers would claim. Pushed on every attach (main takes them only from a window
// that hosts a surface) and whenever keybindings or the shortcut policy change.
export function syncNativeTerminalForwardedChords(): void {
  pushForwardedChords()
  unsubscribe ??= useAppStore.subscribe((state, previous) => {
    if (
      state.keybindings !== previous.keybindings ||
      state.settings?.terminalShortcutPolicy !== previous.settings?.terminalShortcutPolicy
    ) {
      pushForwardedChords()
    }
  })
}
