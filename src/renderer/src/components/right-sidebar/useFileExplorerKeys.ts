import { useEffect, useRef } from 'react'
import type React from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import type { InlineInput } from './FileExplorerRow'
import type { TreeNode } from './file-explorer-types'
import { formatFileExplorerPathsForClipboard } from './file-explorer-selection'
import {
  fileExplorerHasRedo,
  fileExplorerHasUndo,
  redoFileExplorer,
  undoFileExplorer
} from './fileExplorerUndoRedo'
import { keybindingMatchesAction } from '../../../../shared/keybindings'

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
  selectedPaths: Set<string>
  selectedNode: TreeNode | null
  selectedNodes: TreeNode[]
  startRename: (node: TreeNode) => void
  requestDelete: (node: TreeNode) => void
  requestDeleteAll: (nodes: TreeNode[]) => void
}): void {
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const keybindings = useAppStore((s) => s.keybindings)

  const flatRowsRef = useRef(opts.flatRows)
  flatRowsRef.current = opts.flatRows
  const inlineInputRef = useRef(opts.inlineInput)
  inlineInputRef.current = opts.inlineInput
  const selectedPathsRef = useRef(opts.selectedPaths)
  selectedPathsRef.current = opts.selectedPaths
  const selectedNodeRef = useRef(opts.selectedNode)
  selectedNodeRef.current = opts.selectedNode
  const selectedNodesRef = useRef(opts.selectedNodes)
  selectedNodesRef.current = opts.selectedNodes
  const startRenameRef = useRef(opts.startRename)
  startRenameRef.current = opts.startRename
  const requestDeleteRef = useRef(opts.requestDelete)
  requestDeleteRef.current = opts.requestDelete
  const requestDeleteAllRef = useRef(opts.requestDeleteAll)
  requestDeleteAllRef.current = opts.requestDeleteAll

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
      const platform = getShortcutPlatform()
      const wantUndo =
        keybindingMatchesAction('fileExplorer.undo', e, platform, keybindings) &&
        fileExplorerHasUndo()
      const wantRedo =
        keybindingMatchesAction('fileExplorer.redo', e, platform, keybindings) &&
        fileExplorerHasRedo()
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
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
            e.preventDefault()
            startRenameRef.current(node)
            return
          }
          const wantsDelete = keybindingMatchesAction(
            'fileExplorer.delete',
            e,
            platform,
            keybindings
          )
          if (wantsDelete) {
            e.preventDefault()
            requestDeleteAllRef.current(
              selectedNodesRef.current.length > 1 ? selectedNodesRef.current : [node]
            )
            return
          }
        }
      }

      // ── Modifier shortcuts: only when focus is inside the explorer ──
      // Scoped to explorer focus to avoid intercepting editor/terminal shortcuts
      if (!focusInExplorer()) {
        return
      }
      const wantsCopyRelativePath = keybindingMatchesAction(
        'fileExplorer.copyRelativePath',
        e,
        platform,
        keybindings
      )
      const wantsCopyPath = keybindingMatchesAction(
        'fileExplorer.copyPath',
        e,
        platform,
        keybindings
      )
      if (!wantsCopyRelativePath && !wantsCopyPath) {
        return
      }

      const node = selectedNodeRef.current ?? findFocusedNode()
      const selectedNodes = flatRowsRef.current.filter((row) =>
        selectedPathsRef.current.has(row.path)
      )
      const fallbackNodes = selectedNodes.length > 0 ? selectedNodes : node ? [node] : []
      if (fallbackNodes.length === 0) {
        return
      }
      // ⌥⇧⌘C (Mac) / Ctrl+Shift+Alt+C (Win) — Copy Relative Path
      if (wantsCopyRelativePath) {
        e.preventDefault()
        window.api.ui.writeClipboardText(
          formatFileExplorerPathsForClipboard(fallbackNodes, 'relative')
        )
        return
      }
      // ⌥⌘C (Mac) / Shift+Alt+C (Win) — Copy Path
      if (wantsCopyPath) {
        e.preventDefault()
        window.api.ui.writeClipboardText(
          formatFileExplorerPathsForClipboard(fallbackNodes, 'absolute')
        )
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [keybindings, rightSidebarOpen, rightSidebarTab, opts.containerRef])
}
