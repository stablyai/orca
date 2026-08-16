import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { shouldResetFileExplorerForVisibleWorktree } from './file-explorer-reset'
import { decideExpandedDirLoad } from './file-explorer-stale-dir-cache'
import { clearFileExplorerUndoHistory } from './fileExplorerUndoRedo'
import type { DirCache } from './file-explorer-types'
import { splitPathSegments } from './path-tree'

type UseFileExplorerTreeLoadEffectsParams = {
  visibleFilesWorktreePath: string | null
  expanded: Set<string>
  dirCache: Record<string, DirCache>
  rootError: string | null
  isDirStale: (dirPath: string) => boolean
  loadDir: (dirPath: string, depth: number, options?: { force?: boolean }) => Promise<boolean>
  resetAndLoad: () => void
  resetSelection: () => void
  setNameFilterQuery: Dispatch<SetStateAction<string>>
}

/** Reset/retry/stale-dir loads for the currently visible worktree tree. */
export function useFileExplorerTreeLoadEffects({
  visibleFilesWorktreePath,
  expanded,
  dirCache,
  rootError,
  isDirStale,
  loadDir,
  resetAndLoad,
  resetSelection,
  setNameFilterQuery
}: UseFileExplorerTreeLoadEffectsParams): void {
  const sshConnectedGeneration = useAppStore((s) => s.sshConnectedGeneration)

  const lastResetWorktreePathRef = useRef<string | null>(null)
  useEffect(() => {
    if (!visibleFilesWorktreePath) {
      return
    }
    // Why: the sidebar remains mounted while closed to preserve caches, but
    // loading the hidden tree would probe every clicked workspace on macOS.
    if (
      !shouldResetFileExplorerForVisibleWorktree(
        lastResetWorktreePathRef.current,
        visibleFilesWorktreePath
      )
    ) {
      return
    }
    lastResetWorktreePathRef.current = visibleFilesWorktreePath
    resetSelection()
    setNameFilterQuery('')
    resetAndLoad()
    clearFileExplorerUndoHistory()
  }, [visibleFilesWorktreePath, resetSelection]) // eslint-disable-line react-hooks/exhaustive-deps

  // Why: on app startup the file explorer loads before SSH providers are
  // registered, so readDir fails for remote worktrees. When the SSH
  // connection is later established, sshConnectedGeneration bumps and this
  // effect retries the load. Only retries when there was a prior error to
  // avoid redundant reloads for local worktrees.
  const sshGenRef = useRef(sshConnectedGeneration)
  useEffect(() => {
    if (sshConnectedGeneration > sshGenRef.current) {
      sshGenRef.current = sshConnectedGeneration
      if (visibleFilesWorktreePath && rootError) {
        resetAndLoad()
      }
    }
  }, [sshConnectedGeneration, visibleFilesWorktreePath]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visibleFilesWorktreePath) {
      return
    }
    for (const dirPath of expanded) {
      // Why: a full refresh (watcher overflow) re-reads only root and the dirs expanded at the time,
      // so a listing cached while collapsed is unverified — re-read it here instead of trusting it.
      const decision = decideExpandedDirLoad(dirCache[dirPath], isDirStale(dirPath))
      if (decision === 'skip') {
        continue
      }
      const depth = splitPathSegments(dirPath.slice(visibleFilesWorktreePath.length + 1)).length - 1
      void loadDir(dirPath, depth, decision === 'reload' ? { force: true } : undefined)
    }
  }, [expanded, visibleFilesWorktreePath]) // eslint-disable-line react-hooks/exhaustive-deps
}
