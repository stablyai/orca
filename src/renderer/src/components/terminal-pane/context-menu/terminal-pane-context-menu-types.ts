import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../pty-transport/pty-transport-types'
import type { PaneCwdMap } from '../layout/split/resolve-split-cwd'
import type { PreparedAgentSessionFork } from '../session-fork/terminal-agent-session-fork'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session/context/agent-session-continuation'

export type UseTerminalPaneContextMenuDeps = {
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  paneCwdRef: React.RefObject<PaneCwdMap>
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

/** Copy Orca Session ID's click: resolve on the pane's host, then hand focus back to that pane. */
export type TerminalPaneAgentIdCopy = {
  resolve: () => Promise<string | null>
  focusPane: () => void
}
