import { useEffect, useRef, useState } from 'react'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { resolveSplitCwd, type PaneCwdMap } from './resolve-split-cwd'
import type { TerminalQuickCommand } from '../../../../shared/types'
import { sendTerminalQuickCommandToPane } from './terminal-quick-command-dispatch'

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

type UseTerminalPaneContextMenuDeps = {
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  paneCwdRef: React.RefObject<PaneCwdMap>
  fallbackCwd: string
  toggleExpandPane: (paneId: number) => void
  onRequestClosePane: (paneId: number) => void
  onSetTitle: (paneId: number) => void
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
  onPaste: () => Promise<void>
  onSplitRight: () => void
  onSplitDown: () => void
  onEqualizePaneSizes: () => void
  onClosePane: () => void
  onClearScreen: () => void
  onQuickCommand: (command: TerminalQuickCommand) => void
  onToggleExpand: () => void
  onSetTitle: () => void
}

export function useTerminalPaneContextMenu({
  managerRef,
  paneTransportsRef,
  paneCwdRef,
  fallbackCwd,
  toggleExpandPane,
  onRequestClosePane,
  onSetTitle,
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

  const resolveMenuPane = (): ManagedPane | null => {
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
  }

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

  const onPaste = async (): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    const text = await window.api.ui.readClipboardText()
    if (text) {
      pane.terminal.paste(text)
      pane.terminal.focus()
      return
    }
    // Why: clipboard has no text — check for an image (e.g. screenshot).
    // Saves the image to a temp file and pastes the path so CLI tools like
    // Claude Code can access it, consistent with the keyboard paste path.
    const filePath = await window.api.ui.saveClipboardImageAsTempFile()
    if (filePath) {
      pane.terminal.paste(filePath)
    }
    // Why: Radix returns focus to the menu trigger (the pane container) on
    // close, but xterm.js only accepts input when its own helper textarea is
    // focused. Without this, the user has to click the pane again before
    // typing works (see #592).
    pane.terminal.focus()
  }

  // Split-pane CWD inheritance (docs/ssh-split-pane-inherit-cwd.md):
  // mirror the Cmd+D path — sync split on confirmed OSC 7 cache hit,
  // otherwise fall back to async resolveSplitCwd.
  const splitWithInheritedCwd = (direction: 'vertical' | 'horizontal'): void => {
    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    const cached = paneCwdRef.current.get(pane.id)
    if (cached?.confirmed && cached.cwd) {
      managerRef.current?.splitPane(pane.id, direction, { cwd: cached.cwd })
      return
    }
    const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
    const paneId = pane.id
    void (async () => {
      const cwd = await resolveSplitCwd({
        paneCwdMap: paneCwdRef.current,
        sourcePaneId: paneId,
        sourcePtyId: ptyId,
        fallbackCwd
      })
      managerRef.current?.splitPane(paneId, direction, { cwd })
    })()
  }

  const onSplitRight = (): void => splitWithInheritedCwd('vertical')
  const onSplitDown = (): void => splitWithInheritedCwd('horizontal')

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
      pane.terminal.clear()
    }
  }

  const onQuickCommand = (command: TerminalQuickCommand): void => {
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

  const paneCount = managerRef.current?.getPanes().length ?? 1
  const menuPaneId = resolveMenuPane()?.id ?? null

  return {
    open,
    setOpen,
    point,
    menuOpenedAtRef,
    paneCount,
    menuPaneId,
    onContextMenuCapture,
    onCopy,
    onPaste,
    onSplitRight,
    onSplitDown,
    onEqualizePaneSizes,
    onClosePane,
    onClearScreen,
    onQuickCommand,
    onToggleExpand,
    onSetTitle: handleSetTitle
  }
}
