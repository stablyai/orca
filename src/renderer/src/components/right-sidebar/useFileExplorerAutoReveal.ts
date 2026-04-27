import { useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { TreeNode } from './file-explorer-types'

type UseFileExplorerAutoRevealParams = {
  activeFileId: string | null
  activeWorktreeId: string | null
  worktreePath: string | null
  pendingExplorerReveal: { worktreeId: string; filePath: string; requestId: number } | null
  openFiles: OpenFile[]
  rowsByPath: Map<string, TreeNode>
  flatRows: TreeNode[]
  setSelectedPath: Dispatch<SetStateAction<string | null>>
  virtualizer: Virtualizer<HTMLDivElement, Element>
}

/**
 * Auto-reveal: when the active editor file changes, scroll the explorer to show it.
 * This mirrors VS Code's explorer.autoReveal behavior.
 *
 * For files already visible in the tree, scrolls directly (no flash).
 * For files whose ancestors are collapsed, triggers the reveal machinery
 * to expand ancestors and scroll, but skips the flash animation.
 */
export function useFileExplorerAutoReveal({
  activeFileId,
  activeWorktreeId,
  worktreePath,
  pendingExplorerReveal,
  openFiles,
  rowsByPath,
  flatRows,
  setSelectedPath,
  virtualizer
}: UseFileExplorerAutoRevealParams): void {
  const prevActiveFileIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (activeFileId === prevActiveFileIdRef.current) {
      return
    }
    prevActiveFileIdRef.current = activeFileId

    if (!activeFileId || !activeWorktreeId || !worktreePath) {
      return
    }

    // Don't override a pending manual reveal (e.g. from Source Control "Reveal in Explorer")
    if (pendingExplorerReveal) {
      return
    }

    // Why: markdown preview tabs are separate UI surfaces, but they still map
    // to one concrete file on disk and should keep Explorer selection in sync
    // just like a normal edit tab. Diffs and conflict-review tabs do not.
    const activeFile = openFiles.find((f) => f.id === activeFileId)
    if (
      !activeFile ||
      activeFile.worktreeId !== activeWorktreeId ||
      (activeFile.mode !== 'edit' && activeFile.mode !== 'markdown-preview')
    ) {
      return
    }

    const filePath = activeFile.filePath

    if (rowsByPath.has(filePath)) {
      // File is already visible in the tree — just scroll to it and select
      setSelectedPath(filePath)
      const targetIndex = flatRows.findIndex((row) => row.path === filePath)
      if (targetIndex !== -1) {
        requestAnimationFrame(() => {
          virtualizer.scrollToIndex(targetIndex, { align: 'auto' })
        })
      }
    } else {
      // File's ancestor folders aren't expanded — use the reveal machinery
      // to expand them and scroll, but skip the flash animation.
      useAppStore.setState({
        pendingExplorerReveal: {
          worktreeId: activeWorktreeId,
          filePath,
          requestId: Date.now(),
          flash: false
        }
      })
    }
  }, [
    activeFileId,
    activeWorktreeId,
    worktreePath,
    pendingExplorerReveal,
    openFiles,
    rowsByPath,
    flatRows,
    setSelectedPath,
    virtualizer
  ])
}
