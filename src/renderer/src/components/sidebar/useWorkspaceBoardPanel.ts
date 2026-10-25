import { useCallback, useEffect, useRef, useState } from 'react'
import { isEditableTarget } from '@/lib/editable-target'
import { useAppStore } from '@/store'

const WORKSPACE_BOARD_SHEET_SELECTOR = '[data-workspace-board-sheet]'

// Document capture precedes React; let board text fields own Escape before dismissing the panel.
function isWorkspaceBoardEditableTarget(target: EventTarget | null): boolean {
  return (
    isEditableTarget(target) &&
    target instanceof HTMLElement &&
    target.closest(WORKSPACE_BOARD_SHEET_SELECTOR) !== null
  )
}

const WORKSPACE_BOARD_ESCAPE_BLOCKING_OVERLAY_SELECTOR = [
  '[data-slot="dropdown-menu-content"][data-state="open"]',
  '[data-slot="context-menu-content"][data-state="open"]',
  '[data-slot="popover-content"][data-state="open"]',
  '[role="dialog"][data-state="open"]:not([data-workspace-board-sheet])',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]'
].join(', ')

export const TOGGLE_WORKSPACE_BOARD_EVENT = 'orca:toggle-workspace-board'

export type WorkspaceBoardPanelState = {
  workspaceBoardOpen: boolean
  workspaceBoardRenderedOpen: boolean
  workspaceBoardDragPreviewOpen: boolean
  workspaceBoardMenuOpen: boolean
  workspaceBoardSearchRef: (input: HTMLInputElement | null) => void
  openWorkspaceBoard: () => void
  closeWorkspaceBoard: () => void
  toggleWorkspaceBoard: () => void
  handleWorkspaceBoardOpenChange: (open: boolean) => void
  setWorkspaceBoardMenuOpen: (open: boolean) => void
  previewWorkspaceBoardFromDrag: () => void
  solidifyWorkspaceBoardFromDrag: () => void
  cancelWorkspaceBoardDragPreview: () => void
}

export function useWorkspaceBoardPanel(): WorkspaceBoardPanelState {
  const [workspaceBoardOpen, setWorkspaceBoardOpen] = useState(false)
  const [workspaceBoardDragPreviewOpen, setWorkspaceBoardDragPreviewOpen] = useState(false)
  const [workspaceBoardMenuOpen, setWorkspaceBoardMenuOpen] = useState(false)
  const workspaceBoardOpenRef = useRef(workspaceBoardOpen)
  const workspaceBoardDragPreviewOpenRef = useRef(workspaceBoardDragPreviewOpen)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const searchFocusPendingRef = useRef(false)
  const searchOpenerRef = useRef<HTMLElement | null>(null)
  workspaceBoardOpenRef.current = workspaceBoardOpen
  workspaceBoardDragPreviewOpenRef.current = workspaceBoardDragPreviewOpen

  const workspaceBoardSearchRef = useCallback((input: HTMLInputElement | null) => {
    searchInputRef.current = input
    if (input && searchFocusPendingRef.current && workspaceBoardOpenRef.current) {
      searchFocusPendingRef.current = false
      input.focus({ preventScroll: true })
    }
  }, [])

  const openWorkspaceBoard = useCallback(() => {
    if (workspaceBoardOpenRef.current) {
      if (workspaceBoardDragPreviewOpenRef.current) {
        workspaceBoardDragPreviewOpenRef.current = false
        setWorkspaceBoardDragPreviewOpen(false)
      }
      return
    }
    workspaceBoardOpenRef.current = true
    workspaceBoardDragPreviewOpenRef.current = false
    // Record the opening action here rather than in a post-render drawer effect.
    useAppStore.getState().recordFeatureInteraction('workspace-board')
    setWorkspaceBoardOpen(true)
    setWorkspaceBoardDragPreviewOpen(false)
  }, [])

  const closeWorkspaceBoard = useCallback(() => {
    const opener = searchOpenerRef.current
    searchOpenerRef.current = null
    searchFocusPendingRef.current = false
    if (document.activeElement === searchInputRef.current && opener?.isConnected) {
      opener.focus({ preventScroll: true })
    }
    workspaceBoardOpenRef.current = false
    workspaceBoardDragPreviewOpenRef.current = false
    setWorkspaceBoardOpen(false)
    setWorkspaceBoardDragPreviewOpen(false)
    setWorkspaceBoardMenuOpen(false)
  }, [])

  const handleWorkspaceBoardOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        openWorkspaceBoard()
        return
      }
      closeWorkspaceBoard()
    },
    [closeWorkspaceBoard, openWorkspaceBoard]
  )

  const toggleWorkspaceBoard = useCallback(() => {
    if (workspaceBoardOpenRef.current) {
      closeWorkspaceBoard()
      return
    }
    searchOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    searchFocusPendingRef.current = true
    openWorkspaceBoard()
    if (searchInputRef.current) {
      searchFocusPendingRef.current = false
      searchInputRef.current.focus({ preventScroll: true })
    }
  }, [closeWorkspaceBoard, openWorkspaceBoard])

  const previewWorkspaceBoardFromDrag = useCallback(() => {
    if (workspaceBoardOpenRef.current || workspaceBoardDragPreviewOpenRef.current) {
      return
    }
    workspaceBoardDragPreviewOpenRef.current = true
    setWorkspaceBoardDragPreviewOpen(true)
  }, [])

  const solidifyWorkspaceBoardFromDrag = useCallback(() => {
    if (workspaceBoardOpenRef.current) {
      if (workspaceBoardDragPreviewOpenRef.current) {
        workspaceBoardDragPreviewOpenRef.current = false
        setWorkspaceBoardDragPreviewOpen(false)
      }
      return
    }
    workspaceBoardOpenRef.current = true
    workspaceBoardDragPreviewOpenRef.current = false
    useAppStore.getState().recordFeatureInteraction('workspace-board')
    setWorkspaceBoardOpen(true)
    setWorkspaceBoardDragPreviewOpen(false)
  }, [])

  const cancelWorkspaceBoardDragPreview = useCallback(() => {
    if (!workspaceBoardDragPreviewOpenRef.current) {
      return
    }
    workspaceBoardDragPreviewOpenRef.current = false
    setWorkspaceBoardDragPreviewOpen(false)
  }, [])

  useEffect(() => {
    if (!workspaceBoardOpen) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      if (workspaceBoardMenuOpen) {
        return
      }
      if (isWorkspaceBoardEditableTarget(event.target)) {
        return
      }
      // Dismiss interactive nested overlays first; tooltips must not trap Escape.
      if (document.querySelector(WORKSPACE_BOARD_ESCAPE_BLOCKING_OVERLAY_SELECTOR)) {
        return
      }
      event.preventDefault()
      closeWorkspaceBoard()
    }

    // The board is non-modal, so Escape can dismiss it while focus is outside the sheet.
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [closeWorkspaceBoard, workspaceBoardMenuOpen, workspaceBoardOpen])

  useEffect(() => {
    window.addEventListener(TOGGLE_WORKSPACE_BOARD_EVENT, toggleWorkspaceBoard)
    return () => window.removeEventListener(TOGGLE_WORKSPACE_BOARD_EVENT, toggleWorkspaceBoard)
  }, [toggleWorkspaceBoard])

  return {
    workspaceBoardOpen,
    workspaceBoardRenderedOpen: workspaceBoardOpen || workspaceBoardDragPreviewOpen,
    workspaceBoardDragPreviewOpen: workspaceBoardDragPreviewOpen && !workspaceBoardOpen,
    workspaceBoardMenuOpen,
    workspaceBoardSearchRef,
    openWorkspaceBoard,
    closeWorkspaceBoard,
    toggleWorkspaceBoard,
    handleWorkspaceBoardOpenChange,
    setWorkspaceBoardMenuOpen,
    previewWorkspaceBoardFromDrag,
    solidifyWorkspaceBoardFromDrag,
    cancelWorkspaceBoardDragPreview
  }
}
