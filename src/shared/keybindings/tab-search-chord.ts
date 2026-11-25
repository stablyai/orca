import { keybindingMatchesAction } from './matching'
import type { KeybindingInput, KeybindingMatchOptions, KeybindingOverrides } from './types'

/** A focused terminal keeps a chord its own scope also binds (Ctrl+Shift+A is Select All off macOS). */
export function matchesTabSearchChord(
  input: KeybindingInput,
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides,
  options: KeybindingMatchOptions = {}
): boolean {
  return (
    keybindingMatchesAction('tab.search', input, platform, keybindings, options) &&
    !(
      options.context === 'terminal' &&
      keybindingMatchesAction('terminal.selectAll', input, platform, keybindings, options)
    )
  )
}
