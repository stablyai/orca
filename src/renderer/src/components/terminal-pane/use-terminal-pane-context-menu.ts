import { useCallback, useRef } from 'react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { isTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'
import { sendTerminalQuickCommandToPane } from './terminal-quick-command-dispatch'
import type { TerminalPasteSource } from './terminal-paste-model'
import { runQuickCommandInNewTab } from '@/lib/run-quick-command-in-new-tab'
import { pasteTerminalPaneMenuClipboard } from './terminal-pane-menu-paste'
import {
  copyTerminalPaneMenuAgentSessionId,
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
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { resolvePaneAgentSessionId } from './pane-agent-session-id'
import { resetTerminalInputModes } from './terminal-input-mode-reset'
import { equalizeTerminalPanes } from './terminal-pane-layout-owner-commands'
import { buildTerminalPaneContextMenuReveal } from './terminal-pane-context-menu-reveal'
import type {
  TerminalMenuState,
  UseTerminalPaneContextMenuDeps
} from './terminal-pane-context-menu-types'

export function useTerminalPaneContextMenu({
  managerRef,
  paneTransportsRef,
  paneCwdRef,
  resolveContextMenuFileLinkRef,
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

  const {
    open,
    setOpen,
    point,
    menuOpenedAtRef,
    contextMenuFilePathRef,
    onContextMenuCapture,
    onMouseDownCapture,
    onPaneTitleContextMenu
  } = useTerminalContextMenuTrigger({
    managerRef,
    containerRef,
    contextPaneIdRef,
    resolveContextMenuFileLinkRef,
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

  const onCopyTerminalId = async (): Promise<void> => {
    const pane = resolveMenuPane()
    const ptyId = pane ? (paneTransportsRef.current?.get(pane.id)?.getPtyId() ?? null) : null
    return copyTerminalPaneMenuTerminalId(pane, tabId, ptyId)
  }

  const onCopyAgentSessionId = async (): Promise<void> => {
    const pane = resolveMenuPane()
    const sessionId = pane
      ? resolvePaneAgentSessionId(useAppStore.getState(), makePaneKey(tabId, pane.leafId))
      : null
    return copyTerminalPaneMenuAgentSessionId(pane, sessionId)
  }

  const onPaste = async (): Promise<void> => pasteResolvedPane('context-menu')

  const onEqualizePaneSizes = (): void => {
    const pane = resolveMenuPane()
    const manager = managerRef.current
    if (!pane || !manager) {
      return
    }
    equalizeTerminalPanes({ worktreeId, tabId, getManager: () => managerRef.current }, () =>
      pane.terminal.focus()
    )
  }

  const onClosePane = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      onRequestClosePane(pane.id)
    }
  }

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

  const { menuPane, onRevealInFileManager, revealInFileManagerBlocked } =
    buildTerminalPaneContextMenuReveal({
      contextMenuFilePathRef,
      fallbackCwd,
      open,
      paneCwdRef,
      paneTransportsRef,
      resolveMenuPane,
      worktreeId
    })

  // Closed menus need neither pane counts nor target identity; avoid wrapper allocation on every retained-tab render.
  const paneCount = open ? (managerRef.current?.getPanes().length ?? 1) : 1
  const menuPaneId = menuPane?.id ?? null

  return {
    open,
    setOpen,
    point,
    menuOpenedAtRef,
    paneCount,
    menuPaneId,
    onContextMenuCapture,
    onMouseDownCapture,
    onPaneTitleContextMenu,
    onCopy,
    onSelectAll,
    onCopyTerminalId,
    onCopyPaneId,
    onCopyAgentSessionId,
    onPaste,
    onRevealInFileManager,
    revealInFileManagerBlocked,
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
