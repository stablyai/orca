import type { KeybindingOverrides, TerminalShortcutPolicy } from './types'

export type KeybindingGlobalSettings = {
  /** Orca-first keeps app shortcuts from TUIs; terminal-first is opt-in to let shell/TUI bindings win. */
  terminalShortcutPolicy?: TerminalShortcutPolicy
  /** Legacy shortcut overrides; new writes go to ~/.orca/keybindings.json. */
  keybindings?: KeybindingOverrides
  /** Profile-owned defaults; legacy profiles keep their shortcuts without writing the shared file. */
  tabSwitchKeybindingSeed?: 'pending' | 'done' | 'legacy'
  /** The Mac search/clear rollout cohort, independent of the shared shortcut choices. */
  searchKeybindingSeed?: 'pending' | 'done' | 'legacy'
}
