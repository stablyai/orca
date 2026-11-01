import type { KeybindingOverrides } from '../../../../shared/keybindings'
import type { TerminalQuickCommand } from '../../../../shared/types'
import type { TerminalContextMenuLinkTarget } from './terminal-context-menu-link-target'

export type TerminalContextMenuProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  menuPoint: { x: number; y: number }
  menuOpenedAtRef: React.RefObject<number>
  canClosePane: boolean
  canExpandPane: boolean
  menuPaneIsExpanded: boolean
  linkTarget?: TerminalContextMenuLinkTarget | null
  onOpenLinkTarget?: () => void
  onCopyLinkTarget?: () => void
  onRevealLinkTarget?: () => void
  onCopy: () => void
  onPaste: () => void
  onSplitRight: () => void
  onSplitDown: () => void
  keybindings: KeybindingOverrides
  canEqualizePaneSizes: boolean
  onEqualizePaneSizes: () => void
  onClosePane: () => void
  onClearScreen: () => void
  canContinueAgentSessionInNewSession: boolean
  onContinueAgentSessionInNewSession: () => void
  onForkAgentSession: () => void
  canToggleNativeChat: boolean
  isNativeChatView: boolean
  onToggleNativeChat: () => void
  onCopyAgentSessionContext: () => void
  repoQuickCommands: TerminalQuickCommand[]
  globalQuickCommands: TerminalQuickCommand[]
  quickCommandRepoLabel: string | null
  onQuickCommand: (command: TerminalQuickCommand) => void
  onAddQuickCommand: () => void
  onToggleExpand: () => void
  onSetTitle: () => void
  onClearPaneTitle: () => void
  canClearPaneTitle: boolean
  onCopyTerminalId: () => void
  onCopyPaneId: () => void
}
