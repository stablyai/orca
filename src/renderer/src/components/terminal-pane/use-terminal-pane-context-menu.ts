import { useCallback, useRef, useState } from 'react'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport-types'
import type { PaneCwdMap } from './resolve-split-cwd'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { isTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'
import { sendTerminalQuickCommandToPane } from './terminal-quick-command-dispatch'
import type { TerminalPasteSource } from './terminal-paste-model'
import { runQuickCommandInNewTab } from '@/lib/run-quick-command-in-new-tab'
import type { PreparedAgentSessionFork } from './terminal-agent-session-fork'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
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
import { openRoutedHttpLink } from '@/lib/http-link-destinations'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { openDetectedFilePath } from './terminal-file-open-routing'
import {
  getTerminalContextMenuLinkCopyText,
  resolveTerminalContextMenuLinkTarget,
  type TerminalContextMenuLinkTarget
} from './terminal-context-menu-link-target'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { resolvePaneAgentSessionId } from './pane-agent-session-id'
import { resetTerminalInputModes } from './terminal-input-mode-reset'
import { equalizeTerminalPanes } from './terminal-pane-layout-owner-commands'
import type { TerminalLinkRoutingPreferenceRequester } from './terminal-url-link-hit-testing'
import { resolveTerminalHttpLinkSourceOwner } from './terminal-http-link-source-owner'
import { runTerminalCopy } from './terminal-copy-rejection-guards'

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
  requestOpenLinksInAppPreference?: TerminalLinkRoutingPreferenceRequester
}

type TerminalMenuState = {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  point: { x: number; y: number }
  menuOpenedAtRef: React.RefObject<number>
  paneCount: number
  menuPaneId: number | null
  linkTarget: TerminalContextMenuLinkTarget | null
  onOpenLinkTarget: () => void
  onCopyLinkTarget: () => Promise<void>
  onRevealLinkTarget: () => void
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
            runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId),
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
    openDetectedFilePath(linkTarget.absolutePath, linkTarget.line, linkTarget.column, {
      worktreeId,
      worktreePath: worktreePath || fallbackCwd,
      runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    })
  }, [fallbackCwd, linkTarget, requestOpenLinksInAppPreference, worktreeId])

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
    linkTarget,
    onOpenLinkTarget,
    onCopyLinkTarget,
    onRevealLinkTarget,
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
