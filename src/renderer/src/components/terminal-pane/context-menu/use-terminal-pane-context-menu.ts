import type { UseTerminalPaneContextMenuDeps } from './terminal-pane-context-menu-types'
import { createTerminalPaneMenuPaste } from '../input/paste/create-terminal-pane-menu-paste'
import { createTerminalPaneMenuCopyActions } from '../clipboard/create-terminal-pane-menu-copy-actions'
import { createTerminalPaneMenuLayoutActions } from '../layout/ownership/create-terminal-pane-menu-layout-actions'
import { createTerminalPaneMenuAgentSessionActions } from './terminal-pane-menu-agent-session-actions'
import { createTerminalPaneMenuQuickCommand } from '../quick-commands/create-terminal-pane-menu-quick-command'
import { createTerminalPaneMenuTitleActions } from '../titles/create-terminal-pane-menu-title-actions'
import { useCallback, useRef } from 'react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { TerminalQuickCommand } from '../../../../../shared/terminal/quick-commands/terminal-quick-command-types'
import { useTerminalPaneSplitActions } from '../layout/split/use-terminal-pane-split-actions'
import { useTerminalContextMenuTrigger } from './use-terminal-context-menu-trigger'
import { resetTerminalInputModes } from '../input/terminal-input-mode-reset'

type TerminalMenuState = {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  point: { x: number; y: number }
  menuOpenedAtRef: React.RefObject<number>
  paneCount: number
  menuPaneId: number | null
  menuPane: ManagedPane | null
  onContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onMouseDownCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onPaneTitleContextMenu: (event: React.MouseEvent<HTMLElement>, paneId: number) => void
  onCopy: () => Promise<void>
  onSelectAll: () => void
  onCopyTerminalId: () => Promise<void>
  onCopyPaneId: () => Promise<void>
  onCopyAgentSessionId: () => Promise<void>
  onPaste: () => Promise<void>
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
      return panes.find((pane) => pane.id === contextPaneIdRef.current) ?? null
    }
    return manager.getActivePane() ?? panes[0] ?? null
  }, [managerRef])

  const { pasteResolvedPane } = createTerminalPaneMenuPaste({
    managerRef,
    paneTransportsRef,
    tabId,
    worktreeId,
    fallbackCwd,
    onPasteError,
    forceBracketedMultilineTextPaste,
    resolveMenuPane
  })

  const {
    open,
    setOpen,
    point,
    menuOpenedAtRef,
    onContextMenuCapture,
    onMouseDownCapture,
    onPaneTitleContextMenu
  } = useTerminalContextMenuTrigger({
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
    worktreeId,
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

  const { onCopy, onSelectAll, onCopyPaneId, onCopyTerminalId, onCopyAgentSessionId } =
    createTerminalPaneMenuCopyActions({ paneTransportsRef, tabId, resolveMenuPane })

  const onPaste = async (): Promise<void> => pasteResolvedPane('context-menu')

  const { onEqualizePaneSizes, onClosePane } = createTerminalPaneMenuLayoutActions({
    managerRef,
    tabId,
    worktreeId,
    onRequestClosePane,
    resolveMenuPane
  })

  const onClearScreen = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      onClearPaneScrollback(pane)
    }
  }

  const onResetTerminal = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      resetTerminalInputModes(paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null)
    }
  }

  const { onForkAgentSession, onContinueAgentSessionInNewSession, onCopyAgentSessionContext } =
    createTerminalPaneMenuAgentSessionActions({ agentSessionContext, resolveMenuPane })

  const { onQuickCommand } = createTerminalPaneMenuQuickCommand({
    paneTransportsRef,
    tabId,
    worktreeId,
    groupId,
    resolveMenuPane
  })

  const onToggleExpand = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      toggleExpandPane(pane.id)
    }
  }

  const { handleSetTitle, handleClearPaneTitle } = createTerminalPaneMenuTitleActions({
    onSetTitle,
    onClearPaneTitle,
    resolveMenuPane
  })

  const runForPane = <Result>(paneId: number, action: () => Result): Result => {
    const previousPaneId = contextPaneIdRef.current
    contextPaneIdRef.current = paneId
    try {
      return action()
    } finally {
      contextPaneIdRef.current = previousPaneId
    }
  }

  // Closed menus need neither pane counts nor target identity; avoid wrapper allocation on every retained-tab render.
  const paneCount = open ? (managerRef.current?.getPanes().length ?? 1) : 1
  const menuPane = open ? resolveMenuPane() : null
  const menuPaneId = menuPane?.id ?? null

  return {
    open,
    setOpen,
    point,
    menuOpenedAtRef,
    paneCount,
    menuPaneId,
    menuPane,
    onContextMenuCapture,
    onMouseDownCapture,
    onPaneTitleContextMenu,
    onCopy,
    onSelectAll,
    onCopyTerminalId,
    onCopyPaneId,
    onCopyAgentSessionId,
    onPaste,
    onSplitRight,
    onSplitDown,
    onEqualizePaneSizes,
    onClosePane,
    onClearScreen,
    onResetTerminal,
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
