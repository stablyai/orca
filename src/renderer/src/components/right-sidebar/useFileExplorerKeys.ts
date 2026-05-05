import { useEffect, useRef } from 'react'
import type React from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { InlineInput } from './FileExplorerRow'
import type { TreeNode } from './file-explorer-types'
import {
  fileExplorerHasRedo,
  fileExplorerHasUndo,
  redoFileExplorer,
  undoFileExplorer
} from './fileExplorerUndoRedo'

const isMac = navigator.userAgent.includes('Mac')

function isCmdZRedo(e: KeyboardEvent): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (!mod || e.altKey) {
    return false
  }
  if (isMac) {
    return e.code === 'KeyZ' && e.shiftKey
  }
  // Windows/Linux: Ctrl+Shift+Z or Ctrl+Y
  return (e.code === 'KeyZ' && e.shiftKey) || (e.code === 'KeyY' && !e.shiftKey)
}

function isCmdZUndo(e: KeyboardEvent): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (!mod || e.altKey || e.shiftKey) {
    return false
  }
  // Prefer code (layout-independent); fall back to key for edge IME/layout cases.
  return e.code === 'KeyZ' || e.key.toLowerCase() === 'z'
}

/**
 * Keyboard shortcuts for the file explorer.
 *
 * All shortcuts (bare-key and modifier) only fire when focus is inside
 * the explorer container — they must never intercept the editor or terminal.
 */
export function useFileExplorerKeys(opts: {
  containerRef: React.RefObject<HTMLDivElement | null>
  flatRows: TreeNode[]
  inlineInput: InlineInput | null
  selectedNode: TreeNode | null
  startRename: (node: TreeNode) => void
  requestDelete: (node: TreeNode) => void
}): void {
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)

  const flatRowsRef = useRef(opts.flatRows)
  flatRowsRef.current = opts.flatRows
  const inlineInputRef = useRef(opts.inlineInput)
  inlineInputRef.current = opts.inlineInput
  const selectedNodeRef = useRef(opts.selectedNode)
  selectedNodeRef.current = opts.selectedNode
  const startRenameRef = useRef(opts.startRename)
  startRenameRef.current = opts.startRename
  const requestDeleteRef = useRef(opts.requestDelete)
  requestDeleteRef.current = opts.requestDelete

  useEffect(() => {
    // Find the node that the focused button represents (for bare-key shortcuts).
    // Each row button's closest [data-index] gives us the virtualizer index.
    const findFocusedNode = (): TreeNode | null => {
      const el = document.activeElement as HTMLElement | null
      if (!el || !opts.containerRef.current?.contains(el)) {
        return null
      }
      const wrapper = el.closest<HTMLElement>('[data-index]')
      if (!wrapper) {
        return null
      }
      const idx = Number(wrapper.dataset.index)
      return flatRowsRef.current[idx] ?? null
    }

    const focusInExplorer = (): boolean => {
      const el = document.activeElement
      if (!el || !opts.containerRef.current) {
        return false
      }
      if (opts.containerRef.current.contains(el)) {
        return true
      }
      // Fallback: Radix portaled nodes or timing quirks — shell is marked explicitly.
      return (
        el instanceof Element &&
        el.closest('[data-orca-explorer-shell]') === opts.containerRef.current
      )
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!rightSidebarOpen || rightSidebarTab !== 'explorer') {
        return
      }
      if (inlineInputRef.current) {
        return
      }

      // ── Undo/redo for explorer mutations (only when this panel should own the chord).
      // Why: require focus inside the explorer shell (includes the scrollbar, not just
      // the viewport — Radix renders the scrollbar as a sibling of the viewport).
      const inExplorer = focusInExplorer()
      const wantUndo = isCmdZUndo(e) && fileExplorerHasUndo()
      const wantRedo = isCmdZRedo(e) && fileExplorerHasRedo()
      if (inExplorer && (wantUndo || wantRedo)) {
        e.preventDefault()
        const run = wantRedo ? redoFileExplorer() : undoFileExplorer()
        void run.catch((err: unknown) => {
          toast.error(err instanceof Error ? err.message : 'Operation failed')
        })
        return
      }

      // ── Bare-key shortcuts: only when explorer has focus ──
      if (focusInExplorer()) {
        const node = findFocusedNode() ?? selectedNodeRef.current
        if (node) {
          // Enter — Rename
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
            e.preventDefault()
            startRenameRef.current(node)
            return
          }
          // ⌘⌫ (Mac) / Delete (Win) / Forward Delete (Mac full keyboard) — Delete
          if (
            (isMac && e.key === 'Backspace' && e.metaKey) ||
            (isMac && e.key === 'Delete' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) ||
            (!isMac && e.key === 'Delete' && !e.metaKey && !e.ctrlKey)
          ) {
            e.preventDefault()
            requestDeleteRef.current(node)
            return
          }
        }
      }

      // ── Modifier shortcuts: only when focus is inside the explorer ──
      // Scoped to explorer focus to avoid intercepting editor/terminal shortcuts
      if (!focusInExplorer()) {
        return
      }
      const node = selectedNodeRef.current
      if (!node) {
        return
      }
      // ⌥⇧⌘C (Mac) / Ctrl+Shift+Alt+C (Win) — Copy Relative Path
      if (e.code === 'KeyC' && e.altKey && e.shiftKey && (isMac ? e.metaKey : e.ctrlKey)) {
        e.preventDefault()
        window.api.ui.writeClipboardText(node.relativePath)
        return
      }
      // ⌥⌘C (Mac) / Shift+Alt+C (Win) — Copy Path
      if (
        e.code === 'KeyC' &&
        e.altKey &&
        ((isMac && e.metaKey && !e.shiftKey) || (!isMac && e.shiftKey && !e.ctrlKey))
      ) {
        e.preventDefault()
        window.api.ui.writeClipboardText(node.path)
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [rightSidebarOpen, rightSidebarTab, opts.containerRef])
}
