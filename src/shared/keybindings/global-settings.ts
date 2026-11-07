import type { KeybindingOverrides, TerminalShortcutPolicy } from './types'

export type KeybindingGlobalSettings = {
  /** Orca-first keeps app shortcuts from TUIs; terminal-first is opt-in to let shell/TUI bindings win. */
  terminalShortcutPolicy?: TerminalShortcutPolicy
  /** Legacy shortcut overrides; new writes go to ~/.orca/keybindings.json. */
  keybindings?: KeybindingOverrides
  /** Existing profiles pin the old tab-switch shortcuts once; fresh profiles start done. */
  tabSwitchKeybindingSeed?: 'pending' | 'done'
  /** Existing profiles pin the old Mac search/clear shortcuts once before adopting new defaults. */
  searchKeybindingSeed?: 'pending' | 'done'
}
