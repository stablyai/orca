import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { DirCache } from './file-explorer-types'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'

export type CompactFolderExpansionState = {
  rowProjection: FileExplorerRowProjection
  expanded: ReadonlySet<string>
  loadingDirPaths: ReadonlySet<string>
  dirCache: Record<string, DirCache>
}

export type CompactFolderExpansionStep =
  | { kind: 'wait' }
  | { kind: 'done' }
  | { kind: 'open-next'; dirPath: string }

/**
 * What a folder the user just opened still needs under compact folders: once its listing shows a
 * single child folder, that child shares its row and must open too, or every click would only add
 * one more collapsed name to the row.
 */
export function getCompactFolderExpansionStep(
  dirPath: string,
  { rowProjection, expanded, loadingDirPaths, dirCache }: CompactFolderExpansionState
): CompactFolderExpansionStep {
  if (!expanded.has(dirPath)) {
    return { kind: 'done' }
  }
  if (loadingDirPaths.has(dirPath) || !dirCache[dirPath]) {
    return { kind: 'wait' }
  }
  const index = rowProjection.getIndexByPath(dirPath)
  const row = index === null ? null : rowProjection.getRowAtIndex(index)
  if (index === null || !row) {
    return { kind: 'done' }
  }
  const chain = [...rowProjection.getCompactedAncestors(index), row]
  const position = chain.findIndex((node) => node.path === dirPath)
  const next = position === -1 ? undefined : chain[position + 1]
  return next ? { kind: 'open-next', dirPath: next.path } : { kind: 'done' }
}

/**
 * Returns a directory toggle that, with compact folders on, keeps opening the only child folder of
 * each folder it opens as listings arrive (VS Code's `autoExpandSingleChildren`).
 */
export function useFileExplorerCompactFolderExpansion({
  enabled,
  activeWorktreeId,
  toggleDir,
  rowProjection,
  expanded,
  loadingDirPaths,
  dirCache
}: CompactFolderExpansionState & {
  enabled: boolean
  activeWorktreeId: string | null
  toggleDir: (worktreeId: string, dirPath: string) => void
}): (worktreeId: string, dirPath: string) => void {
  // Folders whose single-child chain is still opening.
  const pendingRef = useRef(new Set<string>())

  const toggleDirOpeningChain = useCallback(
    (worktreeId: string, dirPath: string) => {
      const opening = !useAppStore.getState().expandedDirs[worktreeId]?.has(dirPath)
      toggleDir(worktreeId, dirPath)
      if (enabled && opening) {
        pendingRef.current.add(dirPath)
      } else {
        pendingRef.current.delete(dirPath)
      }
    },
    [enabled, toggleDir]
  )

  useEffect(() => {
    const pending = pendingRef.current
    if (!enabled || !activeWorktreeId) {
      pending.clear()
      return
    }
    // Why the store: this effect can belong to a render committed just before the click, whose
    // `expanded` lacks the folder the click opened; only the store tells that from a closed one.
    const isOpen = (dirPath: string): boolean =>
      useAppStore.getState().expandedDirs[activeWorktreeId]?.has(dirPath) === true
    const starts = [...pending]
    pending.clear()
    for (const start of starts) {
      let dirPath = start
      while (isOpen(dirPath)) {
        if (!expanded.has(dirPath)) {
          pending.add(dirPath)
          break
        }
        const step = getCompactFolderExpansionStep(dirPath, {
          rowProjection,
          expanded,
          loadingDirPaths,
          dirCache
        })
        if (step.kind === 'wait') {
          pending.add(dirPath)
          break
        }
        if (step.kind === 'done') {
          break
        }
        dirPath = step.dirPath
        if (!isOpen(dirPath)) {
          toggleDir(activeWorktreeId, dirPath)
          pending.add(dirPath)
          break
        }
      }
    }
  }, [activeWorktreeId, dirCache, enabled, expanded, loadingDirPaths, rowProjection, toggleDir])

  return toggleDirOpeningChain
}
