import type { IDisposable } from '@xterm/xterm'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import type { MacOptionAsAlt } from './terminal-shortcut-policy'
import type { KeybindingOverrides, TerminalShortcutPolicy } from '../../../../shared/keybindings'
import type { PaneCwdMap } from './resolve-split-cwd'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import type { SearchState } from './terminal-keyboard-shortcut-matching'

export type KeyboardHandlersDeps = {
  tabId: string
  worktreeId: string
  isActive: boolean
  keyboardScopeRef: React.RefObject<HTMLElement | null>
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  panePtyBindingsRef: React.RefObject<Map<number, IDisposable>>
  paneCwdRef: React.RefObject<PaneCwdMap>
  fallbackCwd: string
  expandedPaneIdRef: React.RefObject<number | null>
  setExpandedPane: (paneId: number | null) => void
  restoreExpandedLayout: () => void
  refreshPaneSizes: (focusActive: boolean) => void
  persistLayoutSnapshot: () => void
  toggleExpandPane: (paneId: number) => void
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>
  onSearchSelectedText: (text: string) => void
  onRequestClosePane: (paneId: number) => void
  onClearPaneScrollback: (pane: ManagedPane) => void
  onSetTitle: (paneId: number) => void
  onClearPaneTitle: (paneId: number) => void
  searchOpenRef: React.RefObject<boolean>
  searchStateRef: React.RefObject<SearchState>
  macOptionAsAltRef: React.RefObject<MacOptionAsAlt>
  paneKittyKeyboardModesRef?: React.RefObject<Map<number, TerminalKittyKeyboardModeTracker>>
  keybindings?: KeybindingOverrides
  terminalShortcutPolicy?: TerminalShortcutPolicy
}
