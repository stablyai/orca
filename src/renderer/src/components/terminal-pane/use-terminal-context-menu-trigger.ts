import { useEffect, useRef, useState } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { TerminalPasteSource } from './terminal-paste-coordinator'
import { copyTerminalSelection } from './terminal-selection-copy'

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

type UseTerminalContextMenuTriggerDeps = {
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  contextPaneIdRef: React.RefObject<number | null>
  rightClickToPaste: boolean
  pasteResolvedPane: (
    source: Extract<TerminalPasteSource, 'context-menu' | 'right-click'>
  ) => Promise<void>
}

type TerminalContextMenuTrigger = {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  point: { x: number; y: number }
  menuOpenedAtRef: React.RefObject<number>
  onContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onPaneTitleContextMenu: (event: React.MouseEvent<HTMLElement>, paneId: number) => void
}

export function useTerminalContextMenuTrigger({
  managerRef,
  containerRef,
  contextPaneIdRef,
  rightClickToPaste,
  pasteResolvedPane
}: UseTerminalContextMenuTriggerDeps): TerminalContextMenuTrigger {
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

  const openContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    clickedPaneId: number | null,
    boundsElement: HTMLElement
  ): void => {
    event.preventDefault()
    window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
    const manager = managerRef.current
    if (!manager) {
      contextPaneIdRef.current = null
      return
    }
    const clickedPane =
      clickedPaneId !== null
        ? (manager.getPanes().find((pane) => pane.id === clickedPaneId) ?? null)
        : null
    contextPaneIdRef.current = clickedPane?.id ?? null

    // Why: when users opt into terminal-style right-click, a selection copies
    // and no selection pastes. Ctrl+right-click keeps the app menu reachable.
    if (rightClickToPaste && !event.ctrlKey) {
      event.stopPropagation()
      if (!clickedPane) {
        return
      }
      if (clickedPane.terminal.getSelection()) {
        void copyTerminalSelection({
          terminal: clickedPane.terminal,
          writeClipboardText: window.api.ui.writeTerminalClipboardText,
          clearSelectionOnSuccess: true
        }).catch(() => {
          /* ignore clipboard write failures */
        })
      } else {
        void pasteResolvedPane('right-click')
      }
      return
    }

    menuOpenedAtRef.current = Date.now()
    const bounds = boundsElement.getBoundingClientRect()
    setPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
    setOpen(true)
  }

  const onContextMenuCapture = (event: React.MouseEvent<HTMLDivElement>): void => {
    const manager = managerRef.current
    if (!manager) {
      event.preventDefault()
      contextPaneIdRef.current = null
      return
    }
    const target = event.target
    if (!(target instanceof Node)) {
      event.preventDefault()
      contextPaneIdRef.current = null
      return
    }
    const clickedPane = manager.getPanes().find((pane) => pane.container.contains(target)) ?? null
    openContextMenu(event, clickedPane?.id ?? null, event.currentTarget)
  }

  const onPaneTitleContextMenu = (event: React.MouseEvent<HTMLElement>, paneId: number): void => {
    const boundsElement = containerRef.current
    if (!boundsElement) {
      event.preventDefault()
      return
    }
    openContextMenu(event, paneId, boundsElement)
  }

  return { open, setOpen, point, menuOpenedAtRef, onContextMenuCapture, onPaneTitleContextMenu }
}
