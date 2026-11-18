import type { KeybindingOverrides, TerminalShortcutPolicy } from './types'

export type KeybindingGlobalSettings = {
  /** Orca-first keeps app shortcuts from TUIs; terminal-first is opt-in to let shell/TUI bindings win. */
  terminalShortcutPolicy?: TerminalShortcutPolicy
  /** Legacy shortcut overrides; new writes go to ~/.orca/keybindings.json. */
  keybindings?: KeybindingOverrides
  /** Profile-owned defaults; legacy profiles keep their shortcuts without writing the shared file. */
  tabSwitchKeybindingSeed?: 'pending' | 'done' | 'legacy'
  /** The original Mac search/clear rollout cohort. */
  searchKeybindingSeed?: 'pending' | 'done' | 'legacy'
  /** The later Windows/Linux rollout must not reuse the Mac cohort. */
  nonMacSearchKeybindingSeed?: 'pending' | 'done' | 'legacy'
}
