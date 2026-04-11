import { useEffect, useRef, useState } from 'react'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

type UseTerminalPaneContextMenuDeps = {
  managerRef: React.RefObject<PaneManager | null>
  toggleExpandPane: (paneId: number) => void
  onRequestClosePane: (paneId: number) => void
  onSetTitle: (paneId: number) => void
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
  onClosePane: () => void
  onClearScreen: () => void
  onToggleExpand: () => void
  onSetTitle: () => void
}

export function useTerminalPaneContextMenu({
  managerRef,
  toggleExpandPane,
  onRequestClosePane,
  onSetTitle
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
  }

  const onPaste = async (): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    const text = await window.api.ui.readClipboardText()
    if (text) {
      pane.terminal.paste(text)
      return
    }
    // Why: clipboard has no text — check for an image (e.g. screenshot).
    // Saves the image to a temp file and pastes the path so CLI tools like
    // Claude Code can access it, consistent with the keyboard paste path.
    const filePath = await window.api.ui.saveClipboardImageAsTempFile()
    if (filePath) {
      pane.terminal.paste(filePath)
    }
  }

  const onSplitRight = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      managerRef.current?.splitPane(pane.id, 'vertical')
    }
  }

  const onSplitDown = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      managerRef.current?.splitPane(pane.id, 'horizontal')
    }
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
    menuOpenedAtRef.current = Date.now()
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
    onClosePane,
    onClearScreen,
    onToggleExpand,
    onSetTitle: handleSetTitle
  }
}
