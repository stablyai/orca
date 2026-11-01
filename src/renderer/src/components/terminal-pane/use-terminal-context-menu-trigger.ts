import { useEffect, useRef, useState } from 'react'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { TerminalPasteSource } from './terminal-paste-model'
import { copyTerminalSelection } from './terminal-selection-copy'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/close-all-context-menus'
import {
  claimTerminalRightClickPasteMouseDown,
  isTerminalRightClickPasteGesture
} from './terminal-right-click-paste-gesture'
import type {
  TerminalContextMenuFileLinkResolver,
  TerminalContextMenuFilePath
} from './terminal-context-menu-file-link-resolver'

type UseTerminalContextMenuTriggerDeps = {
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  contextPaneIdRef: React.RefObject<number | null>
  resolveContextMenuFileLinkRef: React.RefObject<TerminalContextMenuFileLinkResolver | null>
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
  contextMenuFilePathRef: React.RefObject<TerminalContextMenuFilePath | null>
  onContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onMouseDownCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onPaneTitleContextMenu: (event: React.MouseEvent<HTMLElement>, paneId: number) => void
}

export function useTerminalContextMenuTrigger({
  managerRef,
  containerRef,
  contextPaneIdRef,
  resolveContextMenuFileLinkRef,
  rightClickToPaste,
  pasteResolvedPane
}: UseTerminalContextMenuTriggerDeps): TerminalContextMenuTrigger {
  const menuOpenedAtRef = useRef(0)
  const contextMenuFilePathRef = useRef<TerminalContextMenuFilePath | null>(null)
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
    boundsElement: HTMLElement,
    resolveFileLink: boolean
  ): void => {
    event.preventDefault()
    window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
    const manager = managerRef.current
    if (!manager) {
      contextPaneIdRef.current = null
      contextMenuFilePathRef.current = null
      return
    }
    const clickedPane =
      clickedPaneId !== null
        ? (manager.getPanes().find((pane) => pane.id === clickedPaneId) ?? null)
        : null
    contextPaneIdRef.current = clickedPane?.id ?? null
    // Why: a paste gesture opens no menu, so an earlier menu's file must not reach a later Reveal.
    contextMenuFilePathRef.current = null

    // Configured right-click copies selection or pastes; Ctrl+right-click preserves menu access.
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
          // Failed copy leaves selection available for retry.
        })
      } else {
        void pasteResolvedPane('right-click')
      }
      return
    }

    contextMenuFilePathRef.current =
      resolveFileLink && clickedPane
        ? (resolveContextMenuFileLinkRef.current?.(clickedPane.id, event.nativeEvent) ?? null)
        : null
    menuOpenedAtRef.current = Date.now()
    const bounds = boundsElement.getBoundingClientRect()
    setPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
    setOpen(true)
  }

  const findClickedPane = (target: EventTarget | null): ManagedPane | null => {
    const manager = managerRef.current
    if (!manager || !(target instanceof Node)) {
      return null
    }
    return manager.getPanes().find((pane) => pane.container.contains(target)) ?? null
  }

  const onMouseDownCapture = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!isTerminalRightClickPasteGesture(event, rightClickToPaste)) {
      return
    }
    const clickedPane = findClickedPane(event.target)
    if (clickedPane) {
      claimTerminalRightClickPasteMouseDown(event, clickedPane.terminal)
    }
  }

  const onContextMenuCapture = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!managerRef.current || !(target instanceof Node)) {
      event.preventDefault()
      contextPaneIdRef.current = null
      return
    }
    openContextMenu(event, findClickedPane(target)?.id ?? null, event.currentTarget, true)
  }

  const onPaneTitleContextMenu = (event: React.MouseEvent<HTMLElement>, paneId: number): void => {
    const boundsElement = containerRef.current
    if (!boundsElement) {
      event.preventDefault()
      return
    }
    openContextMenu(event, paneId, boundsElement, false)
  }

  return {
    open,
    setOpen,
    point,
    menuOpenedAtRef,
    contextMenuFilePathRef,
    onContextMenuCapture,
    onMouseDownCapture,
    onPaneTitleContextMenu
  }
}
