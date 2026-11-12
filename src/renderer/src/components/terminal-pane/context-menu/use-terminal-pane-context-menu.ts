import type { UseTerminalPaneContextMenuDeps } from './terminal-pane-context-menu-types'
import { createTerminalPaneMenuPaste } from '../input/paste/create-terminal-pane-menu-paste'
import { createTerminalPaneMenuCopyActions } from '../clipboard/create-terminal-pane-menu-copy-actions'
import { createTerminalPaneMenuLayoutActions } from '../layout/ownership/create-terminal-pane-menu-layout-actions'
import { createTerminalPaneMenuAgentSessionActions } from './terminal-pane-menu-agent-session-actions'
import { createTerminalPaneMenuQuickCommand } from '../quick-commands/create-terminal-pane-menu-quick-command'
import { createTerminalPaneMenuTitleActions } from '../titles/create-terminal-pane-menu-title-actions'
import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import { openRoutedHttpLink } from '@/lib/browser/navigation/http-link-destinations'
import { openDetectedFilePath } from '../links/files/terminal-file-open-routing'
import {
  resolveTerminalHttpLinkSourceOwner,
  resolveTerminalLinkRuntimeEnvironmentId
} from '../links/http/terminal-http-link-source-owner'
import { runTerminalCopy } from '../clipboard/terminal-copy-rejection-guards'
import {
  getTerminalContextMenuLinkCopyText,
  resolveTerminalContextMenuLinkTarget,
  type TerminalContextMenuLinkTarget
} from './terminal-context-menu-link-target'
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
  linkTarget: TerminalContextMenuLinkTarget | null
  onOpenLinkTarget: () => void
  onCopyLinkTarget: () => Promise<void>
  onRevealLinkTarget: () => void
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
  rightClickToPaste,
  requestOpenLinksInAppPreference
}: UseTerminalPaneContextMenuDeps): TerminalMenuState {
  const contextPaneIdRef = useRef<number | null>(null)
  const [linkTarget, setLinkTarget] = useState<TerminalContextMenuLinkTarget | null>(null)

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

  const prepareContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>, clickedPaneId: number | null): boolean => {
      const manager = managerRef.current
      const clickedPane =
        manager && clickedPaneId !== null
          ? (manager.getPanes().find((pane) => pane.id === clickedPaneId) ?? null)
          : null
      if (!clickedPane) {
        setLinkTarget(null)
        return false
      }
      const state = useAppStore.getState()
      const worktree = state.getKnownWorktreeById(worktreeId)
      const worktreePath =
        worktree && 'path' in worktree && typeof worktree.path === 'string'
          ? worktree.path
          : fallbackCwd
      const startupCwd = paneCwdRef.current.get(clickedPane.id)?.cwd || fallbackCwd || worktreePath
      const resolved = startupCwd
        ? resolveTerminalContextMenuLinkTarget(clickedPane.terminal, event.nativeEvent, {
            startupCwd,
            worktreeId,
            worktreePath: worktreePath || startupCwd,
            runtimeEnvironmentId: resolveTerminalLinkRuntimeEnvironmentId(
              paneTransportsRef.current.get(clickedPane.id),
              state,
              worktreeId
            ),
            sourceOwner: resolveTerminalHttpLinkSourceOwner(
              paneTransportsRef.current.get(clickedPane.id)
            )
          })
        : null
      setLinkTarget(resolved)
      return resolved !== null
    },
    [fallbackCwd, managerRef, paneCwdRef, paneTransportsRef, worktreeId]
  )

  const onOpenLinkTarget = useCallback((): void => {
    if (!linkTarget) {
      return
    }
    if (linkTarget.kind === 'http') {
      openRoutedHttpLink(linkTarget.url, {
        worktreeId,
        sourceOwner: linkTarget.sourceOwner,
        requestOpenLinksInAppPreference
      })
      return
    }
    const state = useAppStore.getState()
    const worktree = state.getKnownWorktreeById(worktreeId)
    const worktreePath =
      worktree && 'path' in worktree && typeof worktree.path === 'string'
        ? worktree.path
        : fallbackCwd
    const pane = resolveMenuPane()
    openDetectedFilePath(linkTarget.absolutePath, linkTarget.line, linkTarget.column, {
      worktreeId,
      worktreePath: worktreePath || fallbackCwd,
      runtimeEnvironmentId: resolveTerminalLinkRuntimeEnvironmentId(
        pane ? paneTransportsRef.current.get(pane.id) : null,
        state,
        worktreeId
      )
    })
  }, [fallbackCwd, linkTarget, paneTransportsRef, requestOpenLinksInAppPreference, resolveMenuPane, worktreeId])

  const onCopyLinkTarget = useCallback(async (): Promise<void> => {
    if (!linkTarget) {
      return
    }
    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    await runTerminalCopy({
      selection: getTerminalContextMenuLinkCopyText(linkTarget),
      writeClipboardText: window.api.ui.writeClipboardText,
      // Why: a rejected clipboard write must not leave xterm unfocused after Radix closes the menu.
      focus: () => pane.terminal.focus()
    })
  }, [linkTarget, resolveMenuPane])

  const onRevealLinkTarget = useCallback((): void => {
    if (!linkTarget || linkTarget.kind !== 'file') {
      return
    }
    void window.api.shell.openInFileManager(linkTarget.absolutePath)
  }, [linkTarget])

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
    pasteResolvedPane,
    prepareContextMenu
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
    // Escape or an item that skips refocus (e.g. an empty paste) unmounts the focused menu onto <body>.
    onRestoreTerminalFocus: () => focusPaneIfFocusUnclaimed(resolveMenuPane()),
    onContextMenuCapture,
    onMouseDownCapture,
    onPaneTitleContextMenu,
    linkTarget,
    onOpenLinkTarget,
    onCopyLinkTarget,
    onRevealLinkTarget,
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
