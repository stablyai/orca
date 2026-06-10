/* eslint-disable max-lines -- Why: context-menu actions share pane refs, focus
 * recovery, inherited-cwd split behavior, and agent-fork state in one hook. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { getConnectionId } from '@/lib/connection-context'
import { resolveSplitCwd, type PaneCwdMap } from './resolve-split-cwd'
import type { TerminalQuickCommand } from '../../../../shared/types'
import { isTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'
import { sendTerminalQuickCommandToPane } from './terminal-quick-command-dispatch'
import { splitWebRuntimeTerminal } from '@/runtime/web-runtime-session'
import { pasteTerminalText } from './terminal-bracketed-paste'
import { pasteTerminalClipboard } from './terminal-clipboard-paste'
import { scheduleImagePasteWebglAtlasRecovery } from './terminal-webgl-paste-recovery'
import {
  REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT,
  type RequestActiveTerminalPaneSplitDetail
} from '@/constants/terminal'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { runQuickCommandInNewTab } from '@/lib/run-quick-command-in-new-tab'
import {
  prepareAgentSessionForkFromPane,
  type PreparedAgentSessionFork
} from './terminal-agent-session-fork'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

export function recordContextMenuCreatedTerminalPaneSplit(
  createdPane: unknown,
  args: {
    source: 'contextual_tour' | 'context_menu'
    direction: 'vertical' | 'horizontal'
  }
): boolean {
  return recordCreatedTerminalPaneSplit(createdPane, args)
}

type UseTerminalPaneContextMenuDeps = {
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  paneCwdRef: React.RefObject<PaneCwdMap>
  tabId: string
  worktreeId: string
  groupId: string | null
  fallbackCwd: string
  toggleExpandPane: (paneId: number) => void
  onRequestClosePane: (paneId: number) => void
  onClearPaneScrollback: (pane: ManagedPane) => void
  onSetTitle: (paneId: number) => void
  onPasteError: (message: string) => void
  onAgentSessionForkReady: (fork: PreparedAgentSessionFork) => void
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
  onCopy: () => Promise<void>
  onCopyPaneId: () => Promise<void>
  onPaste: () => Promise<void>
  onSplitRight: () => void
  onSplitDown: () => void
  onEqualizePaneSizes: () => void
  onClosePane: () => void
  onClearScreen: () => void
  onForkAgentSession: () => Promise<void>
  onQuickCommand: (command: TerminalQuickCommand) => void
  onToggleExpand: () => void
  onSetTitle: () => void
}

export function useTerminalPaneContextMenu({
  managerRef,
  paneTransportsRef,
  paneCwdRef,
  tabId,
  worktreeId,
  groupId,
  fallbackCwd,
  toggleExpandPane,
  onRequestClosePane,
  onClearPaneScrollback,
  onSetTitle,
  onPasteError,
  onAgentSessionForkReady,
  rightClickToPaste
}: UseTerminalPaneContextMenuDeps): TerminalMenuState {
  const contextPaneIdRef = useRef<number | null>(null)
  const menuOpenedAtRef = useRef(0)
  const [open, setOpen] = useState(false)
  const [point, setPoint] = useState({ x: 0, y: 0 })

  useEffect(() => {
    const closeMenu = (): void => {
      if (Date.now() - menuOpenedAtRef.current < 100) {
        return
      }
      setOpen(false)
    }
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  const resolveMenuPane = useCallback((): ManagedPane | null => {
    const manager = managerRef.current
    if (!manager) {
      return null
    }
    const panes = manager.getPanes()
    if (contextPaneIdRef.current !== null) {
      const clickedPane = panes.find((pane) => pane.id === contextPaneIdRef.current) ?? null
      if (clickedPane) {
        return clickedPane
      }
    }
    return manager.getActivePane() ?? panes[0] ?? null
  }, [managerRef])

  const onCopy = async (): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    const selection = pane.terminal.getSelection()
    if (selection) {
      await window.api.ui.writeClipboardText(selection)
    }
    // Why: Radix returns focus to the menu trigger (the pane container) on
    // close, but xterm.js only accepts input when its own helper textarea is
    // focused. Without this, the user has to click the pane again before
    // typing works (see #592).
    pane.terminal.focus()
  }

  const onCopyPaneId = async (): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    // Why: orchestration targets use ORCA_PANE_KEY, which survives renderer
    // remounts; the numeric PaneManager id is only a local runtime handle.
    await window.api.ui.writeClipboardText(makePaneKey(tabId, pane.leafId))
    toast.success(
      translate(
        'auto.components.terminal.pane.use.terminal.pane.context.menu.a29b9faa01',
        'Pane ID copied'
      )
    )
    pane.terminal.focus()
  }

  const onPaste = async (): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    const connectionId = getConnectionId(worktreeId) ?? null
    await pasteTerminalClipboard({
      readClipboardText: window.api.ui.readClipboardText,
      saveClipboardImageAsTempFile: window.api.ui.saveClipboardImageAsTempFile,
      connectionId,
      pasteText: (text, options) => {
        pasteTerminalText(pane.terminal, text, options)
        if (options?.forceBracketedPaste) {
          scheduleImagePasteWebglAtlasRecovery()
        }
      },
      onImagePasteError: (error) => {
        const detail = error instanceof Error ? error.message : String(error)
        onPasteError(`Image paste failed: ${detail}`)
      }
    })
    // Why: Radix returns focus to the menu trigger (the pane container) on
    // close, but xterm.js only accepts input when its own helper textarea is
    // focused. Without this, the user has to click the pane again before
    // typing works (see #592).
    pane.terminal.focus()
  }

  // Split-pane CWD inheritance (docs/ssh-split-pane-inherit-cwd.md):
  // mirror the Cmd+D path — sync split on confirmed OSC 7 cache hit,
  // otherwise fall back to async resolveSplitCwd.
  const splitWithInheritedCwd = useCallback(
    (
      direction: 'vertical' | 'horizontal',
      source: 'contextual_tour' | 'context_menu' = 'context_menu'
    ): void => {
      const pane = resolveMenuPane()
      if (!pane) {
        return
      }
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
      if (splitWebRuntimeTerminal(ptyId, direction, source)) {
        return
      }
      const cached = paneCwdRef.current.get(pane.id)
      if (cached?.confirmed && cached.cwd) {
        const createdPane = managerRef.current?.splitPane(pane.id, direction, { cwd: cached.cwd })
        recordContextMenuCreatedTerminalPaneSplit(createdPane, { source, direction })
        return
      }
      const paneId = pane.id
      void (async () => {
        const cwd = await resolveSplitCwd({
          paneCwdMap: paneCwdRef.current,
          sourcePaneId: paneId,
          sourcePtyId: ptyId,
          fallbackCwd
        })
        const createdPane = managerRef.current?.splitPane(paneId, direction, { cwd })
        recordContextMenuCreatedTerminalPaneSplit(createdPane, { source, direction })
      })()
    },
    [fallbackCwd, managerRef, paneCwdRef, paneTransportsRef, resolveMenuPane]
  )

  const onSplitRight = (): void => splitWithInheritedCwd('vertical')
  const onSplitDown = (): void => splitWithInheritedCwd('horizontal')

  useEffect(() => {
    const onRequestSplit = (event: Event): void => {
      const detail = (event as CustomEvent<RequestActiveTerminalPaneSplitDetail>).detail
      if (detail?.tabId && detail.tabId !== tabId) {
        return
      }
      contextPaneIdRef.current = null
      splitWithInheritedCwd(detail?.direction ?? 'vertical', getRequestedSplitTelemetrySource())
    }
    window.addEventListener(REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT, onRequestSplit)
    return () =>
      window.removeEventListener(REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT, onRequestSplit)
    // splitWithInheritedCwd closes over live refs; re-registering keeps the
    // tour action aligned with the current focused pane and fallback cwd.
  }, [tabId, splitWithInheritedCwd])

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

  const onForkAgentSession = async (): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    const fork = prepareAgentSessionForkFromPane({ pane, tabId, worktreeId, groupId })
    if (fork) {
      onAgentSessionForkReady(fork)
    }
  }

  const onQuickCommand = (command: TerminalQuickCommand): void => {
    if (isTerminalAgentQuickCommand(command)) {
      runQuickCommandInNewTab({ command, worktreeId, groupId })
      return
    }

    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    sendTerminalQuickCommandToPane({
      command,
      pane,
      transport: paneTransportsRef.current.get(pane.id)
    })
  }

  const onToggleExpand = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      toggleExpandPane(pane.id)
    }
  }

  const handleSetTitle = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      onSetTitle(pane.id)
    }
  }

  const onContextMenuCapture = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
    const manager = managerRef.current
    if (!manager) {
      contextPaneIdRef.current = null
      return
    }
    const target = event.target
    if (!(target instanceof Node)) {
      contextPaneIdRef.current = null
      return
    }
    const clickedPane = manager.getPanes().find((pane) => pane.container.contains(target)) ?? null
    contextPaneIdRef.current = clickedPane?.id ?? null

    // Why: Windows terminals treat right-click as copy-or-paste depending on
    // whether text is selected. With a selection, right-click copies it and
    // clears the selection; without one, it pastes. Ctrl+right-click still
    // reaches the app menu so the menu remains discoverable.
    if (rightClickToPaste && !event.ctrlKey) {
      event.stopPropagation()
      const selection = clickedPane?.terminal.getSelection()
      if (selection) {
        void window.api.ui.writeClipboardText(selection)
        clickedPane?.terminal.clearSelection()
      } else {
        void onPaste()
      }
      return
    }

    menuOpenedAtRef.current = Date.now()
    const bounds = event.currentTarget.getBoundingClientRect()
    setPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
    setOpen(true)
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
    onCopy,
    onCopyPaneId,
    onPaste,
    onSplitRight,
    onSplitDown,
    onEqualizePaneSizes,
    onClosePane,
    onClearScreen,
    onForkAgentSession,
    onQuickCommand,
    onToggleExpand,
    onSetTitle: handleSetTitle
  }
}

function getRequestedSplitTelemetrySource(): 'contextual_tour' | 'context_menu' {
  return useAppStore.getState().activeContextualTourId === 'workspace-agent-sessions'
    ? 'contextual_tour'
    : 'context_menu'
}
