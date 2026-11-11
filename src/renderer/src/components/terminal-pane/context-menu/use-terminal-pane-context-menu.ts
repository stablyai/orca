import type { UseTerminalPaneContextMenuDeps } from './terminal-pane-context-menu-types'
import { createTerminalPaneMenuPaste } from '../input/paste/create-terminal-pane-menu-paste'
import { createTerminalPaneMenuCopyActions } from '../clipboard/create-terminal-pane-menu-copy-actions'
import { resolveMenuCommandBlock } from '../clipboard/terminal-pane-menu-copy-actions'
import type { TerminalCommandBlockPart } from '../emulation/commands/terminal-command-block-text'
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
import { focusPaneIfFocusUnclaimed } from '@/lib/pane-manager/pane-focus/pane-overlay-focus'

type TerminalMenuState = {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  point: { x: number; y: number }
  menuOpenedAtRef: React.RefObject<number>
  paneCount: number
  menuPaneId: number | null
  menuPane: ManagedPane | null
  onRestoreTerminalFocus: () => void
  onContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onMouseDownCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onPaneTitleContextMenu: (event: React.MouseEvent<HTMLElement>, paneId: number) => void
  onCopy: () => Promise<void>
  onSelectAll: () => void
  onCopyTerminalId: () => Promise<void>
  onCopyPaneId: () => Promise<void>
  onCopyAgentSessionId: () => Promise<void>
  canCopyCommandBlock: boolean
  onCopyCommandBlock: (part: TerminalCommandBlockPart) => Promise<void>
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
  const menuBufferRowRef = useRef<number | null>(null)
  const resolveMenuBufferRow = useCallback((): number | null => menuBufferRowRef.current, [])

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
    menuBufferRowRef,
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

  const {
    onCopy,
    onSelectAll,
    onCopyPaneId,
    onCopyTerminalId,
    onCopyAgentSessionId,
    onCopyCommandBlock
  } = createTerminalPaneMenuCopyActions({
    paneTransportsRef,
    tabId,
    resolveMenuPane,
    resolveMenuBufferRow
  })

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
  const canCopyCommandBlock = open
    ? resolveMenuCommandBlock(menuPane, menuBufferRowRef.current)
    : false

  return {
    open,
    setOpen,
    point,
    menuOpenedAtRef,
    paneCount,
    menuPaneId,
    menuPane,
    // Escape or an item that skips refocus (e.g. an empty paste) unmounts the focused menu onto <body>.
    onRestoreTerminalFocus: () => focusPaneIfFocusUnclaimed(resolveMenuPane()),
    onContextMenuCapture,
    onMouseDownCapture,
    onPaneTitleContextMenu,
    onCopy,
    onSelectAll,
    onCopyTerminalId,
    onCopyPaneId,
    onCopyAgentSessionId,
    canCopyCommandBlock,
    onCopyCommandBlock,
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
