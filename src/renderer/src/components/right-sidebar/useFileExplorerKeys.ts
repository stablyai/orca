import { useEffect, useLayoutEffect, useRef } from 'react'
import type React from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import type { InlineInput } from './file-explorer-inline-input-row'
import type { TreeNode } from './file-explorer-types'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import { formatFileExplorerPathsForClipboard } from './file-explorer-selection'
import type { LocalPathOpenOwner } from '@/lib/local-path-open-guard'
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
import { isEditableTarget } from '@/lib/editable-target'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

export function shouldIgnoreFileExplorerKeyTarget(target: EventTarget | null): boolean {
  return (
    isEditableTarget(target) ||
    (target instanceof Element &&
      target.closest('[data-ignore-file-explorer-keys="true"]') !== null)
  )
}

/** Scope all explorer shortcuts to its focused container so editor/terminal input remains untouched. */
export function useFileExplorerKeys(opts: {
  containerRef: React.RefObject<HTMLDivElement | null>
  rowProjection: FileExplorerRowProjection
  expandedPaths: Set<string>
  canToggleDirectories: boolean
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
  pathOwner: LocalPathOpenOwner
}): void {
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const rightSidebarExplorerView = useAppStore((s) => s.rightSidebarExplorerView)
  const keybindings = useAppStore((s) => s.keybindings)

  const rowProjectionRef = useRef(opts.rowProjection)
  rowProjectionRef.current = opts.rowProjection
  const expandedPathsRef = useRef(opts.expandedPaths)
  expandedPathsRef.current = opts.expandedPaths
  const canToggleDirectoriesRef = useRef(opts.canToggleDirectories)
  canToggleDirectoriesRef.current = opts.canToggleDirectories
  const inlineInputRef = useRef(opts.inlineInput)
  inlineInputRef.current = opts.inlineInput
  const selectedPathsRef = useRef(opts.selectedPaths)
  selectedPathsRef.current = opts.selectedPaths
  const selectedNodeRef = useRef(opts.selectedNode)
  selectedNodeRef.current = opts.selectedNode
  const pathOwnerRef = useRef(opts.pathOwner)
  useLayoutEffect(() => {
    pathOwnerRef.current = opts.pathOwner
  }, [opts.pathOwner])
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
    // Use virtual-row data-index; inline rename has no TreeNode and falls back to the row above.
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
      return expandedPathsRef.current.has(path)
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (
        !rightSidebarOpen ||
        rightSidebarTab !== 'explorer' ||
        rightSidebarExplorerView !== 'files'
      ) {
        return
      }
      if (inlineInputRef.current) {
        return
      }
      if (shouldIgnoreFileExplorerKeyTarget(e.target)) {
        return
      }

      // Undo owns the whole shell, including Radix’s scrollbar sibling outside the viewport.
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
          toast.error(
            err instanceof Error
              ? err.message
              : translate(
                  'auto.components.right.sidebar.useFileExplorerKeys.8adb953095',
                  'Operation failed'
                )
          )
        })
        return
      }

      if (focusInExplorer()) {
        if (
          applyFileExplorerNavigation(
            {
              rowProjection: rowProjectionRef.current,
              activeWorktreeId: activeWorktreeIdRef.current,
              selectedNode: selectedNodeRef.current,
              isExpanded: isDirExpanded,
              canToggleDirectories: canToggleDirectoriesRef.current,
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
      if (wantsCopyRelativePath) {
        e.preventDefault()
        window.api.ui.writeClipboardText(
          formatFileExplorerPathsForClipboard(fallbackNodes, 'relative', pathOwnerRef.current)
        )
        return
      }
      if (wantsCopyPath) {
        e.preventDefault()
        window.api.ui.writeClipboardText(
          formatFileExplorerPathsForClipboard(fallbackNodes, 'absolute', pathOwnerRef.current)
        )
      }
    }

    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [keybindings, rightSidebarExplorerView, rightSidebarOpen, rightSidebarTab, opts.containerRef])
}
