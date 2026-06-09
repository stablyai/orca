import { useEffect, useRef } from 'react'
import type React from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import type { InlineInput } from './FileExplorerRow'
import type { TreeNode } from './file-explorer-types'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import { formatFileExplorerPathsForClipboard } from './file-explorer-selection'
import {
  fileExplorerHasRedo,
  fileExplorerHasUndo,
  redoFileExplorer,
  undoFileExplorer
} from './fileExplorerUndoRedo'
import {
  applyFileExplorerNavigation,
  type SelectionMode
} from './file-explorer-keyboard-navigation'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { translate } from '@/i18n/i18n'

/**
 * Keyboard shortcuts for the file explorer.
 *
 * All shortcuts (bare-key and modifier) only fire when focus is inside
 * the explorer container — they must never intercept the editor or terminal.
 */
export function useFileExplorerKeys(opts: {
  containerRef: React.RefObject<HTMLDivElement | null>
  rowProjection: FileExplorerRowProjection
  inlineInput: InlineInput | null
  selectedPaths: Set<string>
  selectedNode: TreeNode | null
  activateNode: (node: TreeNode) => void
  moveSelection: (targetPath: string, mode: SelectionMode) => void
  toggleDir: (worktreeId: string, dirPath: string) => void
  startRename: (node: TreeNode) => void
  requestDelete: (node: TreeNode) => void
  requestDeleteAll: (nodes: TreeNode[]) => void
  scrollToIndex: (index: number) => void
  activeWorktreeId: string | null
}): void {
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const keybindings = useAppStore((s) => s.keybindings)

  const rowProjectionRef = useRef(opts.rowProjection)
  rowProjectionRef.current = opts.rowProjection
  const inlineInputRef = useRef(opts.inlineInput)
  inlineInputRef.current = opts.inlineInput
  const selectedPathsRef = useRef(opts.selectedPaths)
  selectedPathsRef.current = opts.selectedPaths
  const selectedNodeRef = useRef(opts.selectedNode)
  selectedNodeRef.current = opts.selectedNode
  const startRenameRef = useRef(opts.startRename)
  startRenameRef.current = opts.startRename
  const requestDeleteRef = useRef(opts.requestDelete)
  requestDeleteRef.current = opts.requestDelete
  const requestDeleteAllRef = useRef(opts.requestDeleteAll)
  requestDeleteAllRef.current = opts.requestDeleteAll
  const activateNodeRef = useRef(opts.activateNode)
  activateNodeRef.current = opts.activateNode
  const moveSelectionRef = useRef(opts.moveSelection)
  moveSelectionRef.current = opts.moveSelection
  const toggleDirRef = useRef(opts.toggleDir)
  toggleDirRef.current = opts.toggleDir
  const scrollToIndexRef = useRef(opts.scrollToIndex)
  scrollToIndexRef.current = opts.scrollToIndex
  const activeWorktreeIdRef = useRef(opts.activeWorktreeId)
  activeWorktreeIdRef.current = opts.activeWorktreeId

  useEffect(() => {
    // Find the row index whose button is currently focused. Each virtualized
    // row's wrapper carries data-index; the inline-rename slot is the only
    // wrapper without a real TreeNode, so it falls back to the row above.
    const findFocusedIndex = (): number | null => {
      const el = document.activeElement as HTMLElement | null
      if (!el || !opts.containerRef.current?.contains(el)) {
        return null
      }
      const wrapper = el.closest<HTMLElement>('[data-index]')
      if (!wrapper) {
        return null
      }
      const raw = wrapper.dataset.index
      if (raw === undefined) {
        return null
      }
      const idx = Number(raw)
      if (rowProjectionRef.current.getRowAtIndex(idx) === null) {
        return idx > 0 ? idx - 1 : null
      }
      return idx
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

    const focusRowAtIndex = (index: number): void => {
      const wrapper = opts.containerRef.current?.querySelector<HTMLElement>(
        `[data-index="${index}"]`
      )
      const button = wrapper?.querySelector<HTMLButtonElement>('button')
      button?.focus()
    }

    const isDirExpanded = (path: string): boolean => {
      const worktreeId = activeWorktreeIdRef.current
      if (!worktreeId) {
        return false
      }
      const expanded = useAppStore.getState().expandedDirs[worktreeId]
      return expanded ? expanded.has(path) : false
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
          toast.error(err instanceof Error ? err.message : translate("auto.components.right.sidebar.useFileExplorerKeys.8adb953095", "Operation failed"))
        })
        return
      }

      // ── Bare-key shortcuts: only when explorer has focus ──
      if (focusInExplorer()) {
        if (
          applyFileExplorerNavigation(
            {
              rowProjection: rowProjectionRef.current,
              activeWorktreeId: activeWorktreeIdRef.current,
              selectedNode: selectedNodeRef.current,
              isExpanded: isDirExpanded,
              findFocusedIndex,
              handlers: {
                moveSelection: moveSelectionRef.current,
                toggleDir: toggleDirRef.current,
                scrollToIndex: scrollToIndexRef.current,
                focusRowAtIndex
              }
            },
            e
          )
        ) {
          return
        }

        // ── Space activates the focused row (open file / toggle folder). ──
        if (e.key === ' ' && !e.shiftKey) {
          const focused = findFocusedIndex()
          const node =
            (focused !== null ? rowProjectionRef.current.getRowAtIndex(focused) : null) ??
            selectedNodeRef.current
          if (node) {
            e.preventDefault()
            activateNodeRef.current(node)
            return
          }
        }

        const focused = findFocusedIndex()
        const node =
          (focused !== null ? rowProjectionRef.current.getRowAtIndex(focused) : null) ??
          selectedNodeRef.current
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
            const selectedNodes = rowProjectionRef.current.getRowsByPaths(selectedPathsRef.current)
            requestDeleteAllRef.current(selectedNodes.length > 1 ? selectedNodes : [node])
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

      const focused = findFocusedIndex()
      const node =
        (focused !== null ? rowProjectionRef.current.getRowAtIndex(focused) : null) ??
        selectedNodeRef.current
      const selectedNodes = rowProjectionRef.current.getRowsByPaths(selectedPathsRef.current)
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
