import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import type { PaneCwdMap } from './resolve-split-cwd'
import type { PreparedAgentSessionFork } from './terminal-agent-session-fork'
import type { PtyTransport } from './pty-transport-types'
import type { TerminalContextMenuFileLinkResolver } from './terminal-context-menu-file-link-resolver'

export type UseTerminalPaneContextMenuDeps = {
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  paneCwdRef: React.RefObject<PaneCwdMap>
  resolveContextMenuFileLinkRef: React.RefObject<TerminalContextMenuFileLinkResolver | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  tabId: string
  worktreeId: string
  groupId: string | null
  fallbackCwd: string
  toggleExpandPane: (paneId: number) => void
  onRequestClosePane: (paneId: number) => void
  onClearPaneScrollback: (pane: ManagedPane) => void
  onSetTitle: (paneId: number) => void
  onClearPaneTitle: (paneId: number) => void
  onPasteError: (message: string) => void
  onAgentSessionForkReady: (fork: PreparedAgentSessionFork) => void
  onAgentSessionContinuationReady: (request: AgentSessionContinuationRequest) => void
  forceBracketedMultilineTextPaste: boolean
  rightClickToPaste: boolean
}

export type TerminalMenuState = {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  point: { x: number; y: number }
  menuOpenedAtRef: React.RefObject<number>
  paneCount: number
  menuPaneId: number | null
  onContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onMouseDownCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onPaneTitleContextMenu: (event: React.MouseEvent<HTMLElement>, paneId: number) => void
  onCopy: () => Promise<void>
  onSelectAll: () => void
  onCopyTerminalId: () => Promise<void>
  onCopyPaneId: () => Promise<void>
  onCopyAgentSessionId: () => Promise<void>
  onPaste: () => Promise<void>
  onRevealInFileManager: () => Promise<void>
  revealInFileManagerBlocked: boolean
  onSplitRight: () => void
  onSplitDown: () => void
  onEqualizePaneSizes: () => void
  onClosePane: () => void
  onClearScreen: () => void
  onResetTerminal: () => void
  onForkAgentSession: () => Promise<void>
  onContinueAgentSessionInNewSession: () => void
  onCopyAgentSessionContext: () => Promise<void>
  onQuickCommand: (command: TerminalQuickCommand, historyId: string) => void
  onToggleExpand: () => void
  onSetTitle: () => void
  onClearPaneTitle: () => void
  runForPane: <Result>(paneId: number, action: () => Result) => Result
}
