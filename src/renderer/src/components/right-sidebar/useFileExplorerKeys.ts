import { useEffect, useRef } from 'react'
import type React from 'react'
import { useAppStore } from '@/store'
import type { InlineInput } from './FileExplorerRow'
import type { TreeNode } from './file-explorer-types'

const isMac = navigator.userAgent.includes('Mac')

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
      return !!el && !!opts.containerRef.current?.contains(el)
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!rightSidebarOpen || rightSidebarTab !== 'explorer') {
        return
      }
      if (inlineInputRef.current) {
        return
      }

      // ── Bare-key shortcuts: only when explorer has focus ──
      if (focusInExplorer()) {
        const node = findFocusedNode()
        if (node) {
          // Enter — Rename
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
            e.preventDefault()
            startRenameRef.current(node)
            return
          }
          // ⌘⌫ (Mac) / Delete (Win) — Delete
          if (
            (isMac && e.key === 'Backspace' && e.metaKey) ||
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

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [rightSidebarOpen, rightSidebarTab, opts.containerRef])
}
