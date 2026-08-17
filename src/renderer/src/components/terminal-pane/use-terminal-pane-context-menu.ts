import { useCallback, useRef } from 'react'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import type { PaneCwdMap } from './resolve-split-cwd'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { isTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'
import { sendTerminalQuickCommandToPane } from './terminal-quick-command-dispatch'
import type { TerminalPasteSource } from './terminal-paste-coordinator'
import { runQuickCommandInNewTab } from '@/lib/run-quick-command-in-new-tab'
import type { PreparedAgentSessionFork } from './terminal-agent-session-fork'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { pasteTerminalPaneMenuClipboard } from './terminal-pane-menu-paste'
import {
  copyTerminalPaneMenuPaneId,
  copyTerminalPaneMenuSelection,
  copyTerminalPaneMenuTerminalId
} from './terminal-pane-menu-copy-actions'
import {
  continueAgentSessionFromMenuPane,
  copyAgentSessionContextFromMenuPane,
  forkAgentSessionFromMenuPane
} from './terminal-pane-menu-agent-session-actions'
import { useTerminalPaneSplitActions } from './use-terminal-pane-split-actions'
import { useTerminalContextMenuTrigger } from './use-terminal-context-menu-trigger'

type UseTerminalPaneContextMenuDeps = {
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

type TerminalMenuState = {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  point: { x: number; y: number }
  menuOpenedAtRef: React.RefObject<number>
  paneCount: number
  menuPaneId: number | null
  onContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onPaneTitleContextMenu: (event: React.MouseEvent<HTMLElement>, paneId: number) => void
  onCopy: () => Promise<void>
  onSelectAll: () => void
  onCopyTerminalId: () => Promise<void>
  onCopyPaneId: () => Promise<void>
  onPaste: () => Promise<void>
  onSplitRight: () => void
  onSplitDown: () => void
  onEqualizePaneSizes: () => void
  onClosePane: () => void
  onClearScreen: () => void
  onForkAgentSession: () => Promise<void>
  onContinueAgentSessionInNewSession: () => void
  onCopyAgentSessionContext: () => Promise<void>
  onQuickCommand: (command: TerminalQuickCommand, historyId: string) => void
  onToggleExpand: () => void
  onSetTitle: () => void
  onClearPaneTitle: () => void
  runForPane: <Result>(paneId: number, action: () => Result) => Result
}

export function useTerminalPaneContextMenu({
  managerRef,
  paneTransportsRef,
  paneCwdRef,
  containerRef,
  tabId,
  worktreeId,
  groupId,
  fallbackCwd,
  toggleExpandPane,
  onRequestClosePane,
  onClearPaneScrollback,
  onSetTitle,
  onClearPaneTitle,
  onPasteError,
  onAgentSessionForkReady,
  onAgentSessionContinuationReady,
  forceBracketedMultilineTextPaste,
  rightClickToPaste
}: UseTerminalPaneContextMenuDeps): TerminalMenuState {
  const contextPaneIdRef = useRef<number | null>(null)

  const resolveMenuPane = useCallback((): ManagedPane | null => {
    const manager = managerRef.current
    if (!manager) {
      return null
    }
    const panes = manager.getPanes()
    if (contextPaneIdRef.current !== null) {
      const clickedPane = panes.find((pane) => pane.id === contextPaneIdRef.current) ?? null
      return clickedPane
    }
    return manager.getActivePane() ?? panes[0] ?? null
  }, [managerRef])

  const pasteResolvedPane = async (
    source: Extract<TerminalPasteSource, 'context-menu' | 'right-click'>
  ): Promise<void> =>
    pasteTerminalPaneMenuClipboard(
      {
        managerRef,
        paneTransportsRef,
        tabId,
        worktreeId,
        forceBracketedMultilineTextPaste,
        onPasteError
      },
      resolveMenuPane(),
      source
    )

  const { open, setOpen, point, menuOpenedAtRef, onContextMenuCapture, onPaneTitleContextMenu } =
    useTerminalContextMenuTrigger({
      managerRef,
      containerRef,
      contextPaneIdRef,
      rightClickToPaste,
      pasteResolvedPane
    })

  const { onSplitRight, onSplitDown } = useTerminalPaneSplitActions({
    managerRef,
    paneTransportsRef,
    paneCwdRef,
    contextPaneIdRef,
    tabId,
    fallbackCwd,
    resolveMenuPane
  })

  const agentSessionContext = {
    paneCwdRef,
    tabId,
    worktreeId,
    groupId,
    fallbackCwd,
    onAgentSessionForkReady,
    onAgentSessionContinuationReady
  }

  const onCopy = async (): Promise<void> => copyTerminalPaneMenuSelection(resolveMenuPane())

  const onSelectAll = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      pane.terminal.selectAll()
      pane.terminal.focus()
    }
  }

  const onCopyPaneId = async (): Promise<void> =>
    copyTerminalPaneMenuPaneId(resolveMenuPane(), tabId)

  const onCopyTerminalId = async (): Promise<void> =>
    copyTerminalPaneMenuTerminalId(resolveMenuPane(), tabId)

  const onPaste = async (): Promise<void> => pasteResolvedPane('context-menu')

  const onEqualizePaneSizes = (): void => {
    const pane = resolveMenuPane()
    const manager = managerRef.current
    if (!pane || !manager) {
      return
    }
    manager.equalizePaneSizes()
    pane.terminal.focus()
  }

  const onClosePane = (): void => {
    const pane = resolveMenuPane()
    if (pane && (managerRef.current?.getPanes().length ?? 0) > 1) {
      onRequestClosePane(pane.id)
    }
  }

  const onClearScreen = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      onClearPaneScrollback(pane)
    }
  }

  const onForkAgentSession = async (): Promise<void> =>
    forkAgentSessionFromMenuPane(agentSessionContext, resolveMenuPane())

  const onContinueAgentSessionInNewSession = (): void =>
    continueAgentSessionFromMenuPane(agentSessionContext, resolveMenuPane())

  const onCopyAgentSessionContext = async (): Promise<void> =>
    copyAgentSessionContextFromMenuPane(resolveMenuPane())

  const onQuickCommand = (command: TerminalQuickCommand, historyId: string): void => {
    if (isTerminalAgentQuickCommand(command)) {
      runQuickCommandInNewTab({ command, worktreeId, groupId, historyId })
      return
    }

    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    sendTerminalQuickCommandToPane({
      command,
      pane,
      tabId,
      transport: paneTransportsRef.current.get(pane.id)
    })
  }

  const onToggleExpand = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      toggleExpandPane(pane.id)
    }
  }

  /** Routes title edits through the resolved menu pane instead of active pane. */
  const handleSetTitle = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      onSetTitle(pane.id)
    }
  }

  /** Clears the title for the pane that opened the context menu. */
  const handleClearPaneTitle = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      onClearPaneTitle(pane.id)
    }
  }

  const runForPane = <Result>(paneId: number, action: () => Result): Result => {
    const previousPaneId = contextPaneIdRef.current
    contextPaneIdRef.current = paneId
    try {
      return action()
    } finally {
      contextPaneIdRef.current = previousPaneId
    }
  }

  // Why: PaneManager.getPanes() allocates public pane wrappers. Closed menus
  // do not need pane counts or target identity, so avoid that work on every
  // render across hundreds of mounted terminal tabs.
  const paneCount = open ? (managerRef.current?.getPanes().length ?? 1) : 1
  const menuPaneId = open ? (resolveMenuPane()?.id ?? null) : null

  return {
    open,
    setOpen,
    point,
    menuOpenedAtRef,
    paneCount,
    menuPaneId,
    onContextMenuCapture,
    onPaneTitleContextMenu,
    onCopy,
    onSelectAll,
    onCopyTerminalId,
    onCopyPaneId,
    onPaste,
    onSplitRight,
    onSplitDown,
    onEqualizePaneSizes,
    onClosePane,
    onClearScreen,
    onForkAgentSession,
    onContinueAgentSessionInNewSession,
    onCopyAgentSessionContext,
    onQuickCommand,
    onToggleExpand,
    onSetTitle: handleSetTitle,
    onClearPaneTitle: handleClearPaneTitle,
    runForPane
  }
}
