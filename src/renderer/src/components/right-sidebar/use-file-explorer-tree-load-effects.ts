import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { shouldResetFileExplorerForVisibleWorktree } from './file-explorer-reset'
import { clearFileExplorerUndoHistory } from './fileExplorerUndoRedo'
import type { DirCache } from './file-explorer-types'
import { takeRecentWorkspaceSwitchWake } from '@/lib/workspace-switch-user-act'

type UseFileExplorerTreeLoadEffectsParams = {
  /** The store worktree id, keying the user's own switches to this workspace. */
  workspaceKey: string | null
  visibleFilesWorktreePath: string | null
  activeWorktreeId: string | null
  displayRootPath?: string | null
  expanded: Set<string>
  dirCache: Record<string, DirCache>
  loadingDirPaths: ReadonlySet<string>
  rootError: string | null
  invalidateTree: () => void
  retireView: () => void
  reconcileView: (
    requiredDirs: Set<string>,
    canCommit: () => boolean,
    viewError: string | null,
    displayRootPath?: string | null
  ) => void
  loadRevision: number
  interactionBlocked?: boolean
  resetAndLoad: (options?: { wakeWslDistro?: boolean }) => void
  resetSelection: () => void
  setNameFilterQuery: Dispatch<SetStateAction<string>>
}

export function useFileExplorerTreeLoadEffects({
  workspaceKey,
  visibleFilesWorktreePath,
  activeWorktreeId,
  displayRootPath = visibleFilesWorktreePath,
  expanded,
  dirCache,
  loadingDirPaths,
  rootError,
  invalidateTree,
  reconcileView,
  retireView,
  loadRevision,
  interactionBlocked = false,
  resetAndLoad,
  resetSelection,
  setNameFilterQuery
}: UseFileExplorerTreeLoadEffectsParams): void {
  const interactionRef = useRef(interactionBlocked)
  useLayoutEffect(() => {
    interactionRef.current = interactionBlocked
  }, [interactionBlocked])
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
      // The cache outlives its listener; every reveal or workspace reentry must verify it.
      invalidateTree()
      return retireView
    }
    lastResetWorktreePathRef.current = visibleFilesWorktreePath
    resetSelection()
    setNameFilterQuery('')
    // Only the user's own switch here may start its stopped WSL distro (E9), once per switch.
    const wake = workspaceKey !== null && takeRecentWorkspaceSwitchWake(workspaceKey, 'explorer')
    resetAndLoad(wake ? { wakeWslDistro: true } : undefined)
    clearFileExplorerUndoHistory()
    return retireView
  }, [visibleFilesWorktreePath, activeWorktreeId, resetSelection]) // eslint-disable-line react-hooks/exhaustive-deps

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

  useEffect(() => {
    if (!visibleFilesWorktreePath) {
      return
    }
    const requiredDirs = new Set(expanded)
    if (displayRootPath) {
      requiredDirs.add(displayRootPath)
    }
    reconcileView(requiredDirs, () => !interactionRef.current, rootError, displayRootPath)
  }, [
    visibleFilesWorktreePath,
    activeWorktreeId,
    displayRootPath,
    expanded,
    dirCache,
    loadingDirPaths,
    rootError,
    loadRevision,
    interactionBlocked,
    reconcileView
  ])
}
