import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getRelativePathInsideRoot } from '@/lib/path'
import { useCallback, type RefObject } from 'react'
import type { FileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import type {
  DirCache,
  FileExplorerDirectoryReadOptions,
  FileExplorerTreeRefreshOutcome,
  FileExplorerRevealObservation,
  FileExplorerRevealAuthority
} from './file-explorer-types'
import { decideExpandedDirLoad } from './file-explorer-stale-dir-cache'

type Outcome = FileExplorerTreeRefreshOutcome
type Params = {
  worktreePath: string | null
  dirCacheRef: RefObject<Record<string, DirCache>>
  loadingDirPathsRef: RefObject<ReadonlySet<string>>
  staleDirsRef: RefObject<Set<string>>
  executionRef: RefObject<AbortController>
  dirLoadTrackerRef: RefObject<FileExplorerDirLoadTracker>
  automaticCanCommitRef: RefObject<() => boolean>
  rootObservationRef: RefObject<{ promise: Promise<Outcome> } | null>
  observeRoot: (
    options?: FileExplorerDirectoryReadOptions,
    canCommit?: () => boolean
  ) => Promise<Outcome>
  readDir: (
    path: string,
    depth: number,
    options?: FileExplorerDirectoryReadOptions,
    canCommit?: () => boolean
  ) => Promise<Outcome>
}

/** Reveal observes published authority; handler boolean ACKs are not observation completion. */
export function useFileExplorerRevealObservation({
  worktreePath,
  dirCacheRef,
  loadingDirPathsRef,
  staleDirsRef,
  executionRef,
  dirLoadTrackerRef,
  automaticCanCommitRef,
  rootObservationRef,
  observeRoot,
  readDir
}: Params) {
  const getRevealAuthority: FileExplorerRevealAuthority = useCallback(
    (paths, renderedCache) => {
      if (executionRef.current.signal.aborted) {
        return 'pending'
      }
      for (const path of paths) {
        const cache = dirCacheRef.current[path]
        if (
          cache !== renderedCache[path] ||
          loadingDirPathsRef.current.has(path) ||
          dirLoadTrackerRef.current.get(path) ||
          (path === worktreePath && rootObservationRef.current)
        ) {
          return 'pending'
        }
        if (cache?.error !== undefined && !staleDirsRef.current.has(path)) {
          return 'terminal'
        }
        if (decideExpandedDirLoad(cache, staleDirsRef.current.has(path)) !== 'skip') {
          return 'pending'
        }
      }
      return 'ready'
    },
    [
      dirCacheRef,
      dirLoadTrackerRef,
      executionRef,
      loadingDirPathsRef,
      rootObservationRef,
      staleDirsRef,
      worktreePath
    ]
  )

  const observeDirForReveal: FileExplorerRevealObservation = useCallback(
    async (path, depth, origin, isCurrent) => {
      const signal = executionRef.current.signal
      const current = () => !signal.aborted && executionRef.current.signal === signal && isCurrent()
      if (!worktreePath || !current()) {
        return 'superseded'
      }
      const observe = async (dirPath: string, dirDepth: number): Promise<Outcome> => {
        if (!current()) {
          return 'superseded'
        }
        const cache = dirCacheRef.current[dirPath]
        const firstManualListing = origin === 'manual' && !cache?.operationOwner
        const canCommit = () => current() && (firstManualListing || automaticCanCommitRef.current())
        const root = dirPath === worktreePath ? rootObservationRef.current : null
        const token = dirLoadTrackerRef.current.get(dirPath)
        if (!root && !token) {
          if (cache?.error !== undefined && !staleDirsRef.current.has(dirPath)) {
            return 'root-unreadable'
          }
          if (decideExpandedDirLoad(cache, staleDirsRef.current.has(dirPath)) === 'skip') {
            return 'refreshed'
          }
        }
        if (!canCommit()) {
          return 'superseded'
        }
        let result: Outcome
        if (root) {
          result = await root.promise
        } else if (token && !(origin === 'manual' && !token.started)) {
          result = await dirLoadTrackerRef.current.observe(token)
        } else if (token) {
          // An explicit target queued behind unrelated passive work keeps its original no-wake permission.
          result = await readDir(dirPath, dirDepth, undefined, canCommit)
        } else {
          result = await (dirPath === worktreePath
            ? observeRoot(undefined, canCommit)
            : readDir(dirPath, dirDepth, undefined, canCommit))
        }
        return current() && canCommit() ? result : 'superseded'
      }
      const rootResult = await observe(worktreePath, -1)
      if (rootResult !== 'refreshed' || !current()) {
        return rootResult
      }
      return path === worktreePath ? rootResult : observe(path, depth)
    },
    [
      worktreePath,
      dirCacheRef,
      staleDirsRef,
      executionRef,
      dirLoadTrackerRef,
      automaticCanCommitRef,
      rootObservationRef,
      observeRoot,
      readDir
    ]
  )
  return { observeDirForReveal, getRevealAuthority }
}

export function useFileExplorerRevealRequestCurrency(
  activeWorktreeId: string | null,
  displayRootPath: string | null
) {
  return useCallback(
    (request: NonNullable<AppState['pendingExplorerReveal']>, consumed = false): boolean => {
      const state = useAppStore.getState()
      if (
        state.pendingExplorerReveal !== (consumed ? null : request) ||
        state.activeWorktreeId !== activeWorktreeId
      ) {
        return false
      }
      if (request.origin === 'manual') {
        return true
      }
      const active = state.openFiles.find((file) => file.id === state.activeFileId)
      return (
        !!active &&
        active.worktreeId === request.worktreeId &&
        active.filePath === request.filePath &&
        (active.mode === 'edit' || active.mode === 'markdown-preview') &&
        getRelativePathInsideRoot(active.filePath, displayRootPath) !== null
      )
    },
    [activeWorktreeId, displayRootPath]
  )
}
