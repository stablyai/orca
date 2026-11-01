import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { shouldResetFileExplorerForVisibleWorktree } from './file-explorer-reset'
import { decideExpandedDirLoad } from './file-explorer-stale-dir-cache'
import { clearFileExplorerUndoHistory } from './fileExplorerUndoRedo'
import type { DirCache } from './file-explorer-types'
import { splitPathSegments } from '../../../../shared/cross-platform-path'
import { takeRecentWorkspaceSwitchWake } from '@/lib/workspace-switch-user-act'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { subscribeRuntimeHostContactRegained } from '@/runtime/runtime-host-contact-regained'

type UseFileExplorerTreeLoadEffectsParams = {
  /** The store worktree id, keying the user's own switches to this workspace. */
  workspaceKey: string | null
  visibleFilesWorktreePath: string | null
  displayRootPath?: string | null
  expanded: Set<string>
  dirCache: Record<string, DirCache>
  loadingDirPaths: ReadonlySet<string>
  rootError: string | null
  isDirStale: (dirPath: string) => boolean
  loadDir: (
    dirPath: string,
    depth: number,
    options?: { force?: boolean; wakeWslDistro?: boolean }
  ) => Promise<boolean>
  refreshTree: () => Promise<unknown>
  resetAndLoad: (options?: { wakeWslDistro?: boolean }) => void
  resetSelection: () => void
  setNameFilterQuery: Dispatch<SetStateAction<string>>
}

export function useFileExplorerTreeLoadEffects({
  workspaceKey,
  visibleFilesWorktreePath,
  displayRootPath = visibleFilesWorktreePath,
  expanded,
  dirCache,
  loadingDirPaths,
  rootError,
  isDirStale,
  loadDir,
  refreshTree,
  resetAndLoad,
  resetSelection,
  setNameFilterQuery
}: UseFileExplorerTreeLoadEffectsParams): void {
  const [completedStaleRefreshes, setCompletedStaleRefreshes] = useState(0)
  const staleRefreshRef = useRef<{
    worktreePath: string
    promise: Promise<unknown>
  } | null>(null)
  useEffect(() => {
    staleRefreshRef.current = null
    return () => {
      staleRefreshRef.current = null
    }
  }, [visibleFilesWorktreePath])
  const followSymlinks = useAppStore((s) => s.settings?.followSymlinkedDirectories ?? false)
  const lastFollowSymlinks = useRef(followSymlinks)
  useEffect(() => {
    if (lastFollowSymlinks.current !== followSymlinks) {
      lastFollowSymlinks.current = followSymlinks
      if (visibleFilesWorktreePath) {
        resetAndLoad()
      }
    }
  }, [followSymlinks, visibleFilesWorktreePath, resetAndLoad])
  const sshConnectedGeneration = useAppStore((s) => s.sshConnectedGeneration)

  const lastResetWorktreePathRef = useRef<string | null>(null)
  useEffect(
    () => () => {
      lastResetWorktreePathRef.current = null
    },
    []
  )
  useEffect(() => {
    if (!visibleFilesWorktreePath) {
      return
    }
    // The hidden sidebar stays mounted for caches; avoid probing every clicked workspace while closed.
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
    // Only the user's own switch here may start its stopped WSL distro (E9), once per switch.
    const wake = workspaceKey !== null && takeRecentWorkspaceSwitchWake(workspaceKey, 'explorer')
    resetAndLoad(wake ? { wakeWslDistro: true } : undefined)
    clearFileExplorerUndoHistory()
  }, [visibleFilesWorktreePath, resetSelection]) // eslint-disable-line react-hooks/exhaustive-deps

  // Retry prior errors after SSH providers register; explorer startup may precede connection readiness.
  const sshGenRef = useRef(sshConnectedGeneration)
  useEffect(() => {
    if (sshConnectedGeneration > sshGenRef.current) {
      sshGenRef.current = sshConnectedGeneration
      if (visibleFilesWorktreePath && rootError) {
        resetAndLoad()
      }
    }
  }, [sshConnectedGeneration, visibleFilesWorktreePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // The same for a runtime host (WSL or SSH server): a relaunch can load before it answers.
  const runtimeEnvironmentId = useAppStore((s) =>
    runtimeEnvironmentIdOrLocalUnlessTwin(s, workspaceKey)
  )
  const retryAfterContactRef = useRef(() => {})
  // Kept current from an effect, not render; the subscription below outlives renders.
  useEffect(() => {
    retryAfterContactRef.current = () => {
      if (visibleFilesWorktreePath && rootError) {
        resetAndLoad()
      }
    }
  }, [visibleFilesWorktreePath, rootError, resetAndLoad])
  useEffect(() => {
    if (!runtimeEnvironmentId) {
      return
    }
    return subscribeRuntimeHostContactRegained(runtimeEnvironmentId, () =>
      retryAfterContactRef.current()
    )
  }, [runtimeEnvironmentId])

  useEffect(() => {
    if (
      !visibleFilesWorktreePath ||
      !displayRootPath ||
      displayRootPath === visibleFilesWorktreePath ||
      dirCache[displayRootPath] ||
      loadingDirPaths.has(displayRootPath)
    ) {
      return
    }
    const depth =
      splitPathSegments(displayRootPath.slice(visibleFilesWorktreePath.length + 1)).length - 1
    void loadDir(displayRootPath, depth)
  }, [visibleFilesWorktreePath, displayRootPath, dirCache, loadingDirPaths, loadDir])

  // Only a folder expanded since the last run of this mount is the user acting (E9): a mount, a
  // workspace switch or a host loss re-running this with the same folders must not wake WSL.
  const seenExpandedRef = useRef<{ worktreePath: string | null; dirs: ReadonlySet<string> }>({
    worktreePath: null,
    dirs: new Set()
  })
  useEffect(() => {
    if (!visibleFilesWorktreePath) {
      return
    }
    const seen = seenExpandedRef.current
    const sameWorkspace = seen.worktreePath === visibleFilesWorktreePath
    seenExpandedRef.current = { worktreePath: visibleFilesWorktreePath, dirs: new Set(expanded) }
    for (const dirPath of expanded) {
      // Refresh waves premark owned dirs; skip them to prevent unbounded duplicate loadDir fan-out.
      if (loadingDirPaths.has(dirPath)) {
        continue
      }
      // Collapsed caches are unverified after watcher overflow; only root/expanded dirs were refreshed.
      if (dirCache[dirPath]?.error) {
        continue
      }
      const decision = decideExpandedDirLoad(dirCache[dirPath], isDirStale(dirPath))
      if (decision === 'skip') {
        continue
      }
      const depth = splitPathSegments(dirPath.slice(visibleFilesWorktreePath.length + 1)).length - 1
      void loadDir(dirPath, depth, {
        ...(sameWorkspace && !seen.dirs.has(dirPath) ? { wakeWslDistro: true } : {}),
        ...(decision === 'reload' ? { force: true } : {})
      })
    }
  }, [expanded, visibleFilesWorktreePath]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (
      !visibleFilesWorktreePath ||
      rootError ||
      loadingDirPaths.size > 0 ||
      staleRefreshRef.current?.worktreePath === visibleFilesWorktreePath ||
      !Array.from(expanded).some(
        (dirPath) => dirCache[dirPath] && !dirCache[dirPath].error && isDirStale(dirPath)
      )
    ) {
      return
    }
    // Reopening during an older read must retry after it drains, using the bounded refresh wave.
    const refresh = { worktreePath: visibleFilesWorktreePath, promise: refreshTree() }
    staleRefreshRef.current = refresh
    const finish = () => {
      if (staleRefreshRef.current === refresh) {
        staleRefreshRef.current = null
        setCompletedStaleRefreshes((count) => count + 1)
      }
    }
    void refresh.promise.then(finish, finish)
  }, [
    visibleFilesWorktreePath,
    rootError,
    loadingDirPaths,
    completedStaleRefreshes,
    expanded,
    dirCache,
    isDirStale,
    refreshTree
  ])
}
