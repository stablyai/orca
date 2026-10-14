import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { DirCache } from './file-explorer-types'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'

type CompactFolderExpansionState = {
  rowProjection: FileExplorerRowProjection
  expanded: ReadonlySet<string>
  loadingDirPaths: ReadonlySet<string>
  dirCache: Record<string, DirCache>
}

type CompactFolderExpansionStep =
  | { kind: 'wait' }
  | { kind: 'done' }
  | { kind: 'open-next'; dirPath: string }

/** A just-opened folder's single child folder shares its row, so it must open too. */
function getCompactFolderExpansionStep(
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

/** Directory toggle that keeps opening single child folders as listings arrive, like VS Code. */
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
    // A render from before the click can commit after it, so ask the store whether a folder is open.
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
