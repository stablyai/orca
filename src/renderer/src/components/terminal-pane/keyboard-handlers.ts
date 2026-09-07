import { useTerminalKeyboardShortcuts } from './terminal-keyboard-hook'

export type { SearchState, SearchNavigationDirection } from './terminal-keyboard-shortcut-matching'

export {
  resolveTerminalKeyboardShortcutAction,
  recordKeyboardCreatedTerminalPaneSplit,
  matchSearchNavigate,
  runTerminalSearchNavigation,
  matchFileSearchShortcut
} from './terminal-keyboard-shortcut-matching'

export { useTerminalKeyboardShortcuts }
