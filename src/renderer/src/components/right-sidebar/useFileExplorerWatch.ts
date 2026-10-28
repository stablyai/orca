import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import type {
  DirCache,
  FileExplorerOperationOwner,
  FileExplorerTreeRefreshOutcome
} from './file-explorer-types'
import type { InlineInput } from './file-explorer-inline-input-row'
import { useAppStore } from '@/store'
import {
  isWorktreeCatchUpPayload,
  ORCA_WORKTREE_FILE_CHANGE_EVENT
} from '@/hooks/worktree-file-change-event'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import {
  getFileExplorerOperationOwner,
  getFileExplorerOperationOwnerFromState,
  type FileExplorerOwnerState
} from './file-explorer-operation-owner'
import { fileExplorerRefreshConcurrency } from './file-explorer-refresh-concurrency'
import { createFileExplorerWatchRefreshScheduler } from './file-explorer-watch-refresh-scheduler'
import { processFileExplorerFsPayload } from './file-explorer-watch-reconcile'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

export {
  canonicalizeFileExplorerWatchPath,
  getExternalFileChangeRelativePath,
  resolveCachedDirPath
} from './file-explorer-watch-path'

type FileExplorerWatchOwnerState = Pick<
  FileExplorerOwnerState,
  'settings' | 'repos' | 'worktreesByRepo'
> &
  Partial<Omit<FileExplorerOwnerState, 'settings' | 'repos' | 'worktreesByRepo'>>

type UseFileExplorerWatchParams = {
  worktreePath: string | null
  activeWorktreeId: string | null
  dirCache: Record<string, DirCache>
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  expanded: Set<string>
  setSelectedPath: Dispatch<SetStateAction<string | null>>
  refreshDir: (dirPath: string) => Promise<void>
  refreshTree: () => Promise<FileExplorerTreeRefreshOutcome>
  inlineInput: InlineInput | null
  dragSourcePath: string | null
  isNativeDragOver: boolean
  operationOwner?: FileExplorerOperationOwner
}

export function getFileExplorerWatchRuntimeEnvironmentId(
  state: FileExplorerWatchOwnerState,
  activeWorktreeId: string | null,
  expectedOwner?: FileExplorerOperationOwner
): string | null | undefined {
  const ownerState: FileExplorerOwnerState = {
    activeWorktreeId: state.activeWorktreeId,
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    settings: state.settings,
    repos: state.repos,
    worktreesByRepo: selectWorktreesByRepo(state),
    detectedWorktreesByRepo: state.detectedWorktreesByRepo ?? {},
    folderWorkspaces: state.folderWorkspaces ?? [],
    projectGroups: state.projectGroups ?? [],
    restoredRuntimeHostIdByWorkspaceSessionKey:
      state.restoredRuntimeHostIdByWorkspaceSessionKey ?? {}
  }
  const owner = getFileExplorerOperationOwnerFromState(ownerState, activeWorktreeId)
  if (expectedOwner && JSON.stringify(owner) !== JSON.stringify(expectedOwner)) {
    return undefined
  }
  return owner.kind === 'runtime'
    ? owner.environmentId
    : owner.kind === 'unresolved'
      ? undefined
      : null
}

/** Reconcile tree caches from fs:changed; useEditorExternalWatch owns the watch IPC lifecycle. */
export function useFileExplorerWatch({
  worktreePath,
  activeWorktreeId,
  dirCache,
  setDirCache,
  expanded,
  setSelectedPath,
  refreshDir,
  refreshTree,
  inlineInput,
  dragSourcePath,
  isNativeDragOver,
  operationOwner
}: UseFileExplorerWatchParams): void {
  // Subscribe by worktree ownership; focused host is only a legacy default.
  const activeRuntimeEnvironmentId = useAppStore((s) =>
    getFileExplorerWatchRuntimeEnvironmentId(s, activeWorktreeId, operationOwner)
  )

  // Keep handler values in refs to avoid listener resubscription on every render.
  const dirCacheRef = useRef(dirCache)
  dirCacheRef.current = dirCache

  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  const inlineInputRef = useRef(inlineInput)
  inlineInputRef.current = inlineInput

  const dragSourceRef = useRef(dragSourcePath)
  dragSourceRef.current = dragSourcePath

  const isNativeDragOverRef = useRef(isNativeDragOver)
  isNativeDragOverRef.current = isNativeDragOver

  // Expansion changes callback identity; refs preserve the subscription.
  const refreshDirRef = useRef(refreshDir)
  refreshDirRef.current = refreshDir

  const refreshTreeRef = useRef(refreshTree)
  refreshTreeRef.current = refreshTree

  const deferredRef = useRef<FsChangedPayload[]>([])
  const resyncWatchKeysRef = useRef(new Set<string>())
  const activeResyncByWatchKeyRef = useRef(new Map<string, () => void>())

  // Bridge payload replay to the flush effect without resubscribing.
  const processPayloadRef = useRef<((payload: FsChangedPayload) => void) | null>(null)

  // Keep setup atomic to prevent cleanup-order races dropping events on rapid switches.
  useEffect(() => {
    // Null worktree keys strand resync state that correctly keyed subscriptions cannot consume.
    if (!worktreePath || !activeWorktreeId || activeRuntimeEnvironmentId === undefined) {
      return
    }

    const currentWorktreePath = worktreePath
    const currentWorktreeId = activeWorktreeId
    const resyncWatchKeys = resyncWatchKeysRef.current
    const activeResyncByWatchKey = activeResyncByWatchKeyRef.current
    const currentWatchKey = JSON.stringify([
      currentWorktreeId,
      normalizeRuntimePathForComparison(currentWorktreePath)
    ])

    // Share one scheduler across transports and scope its lifetime to this worktree so navigation cannot refresh an old root.
    const owner = getFileExplorerOperationOwner(currentWorktreeId)
    const scheduler = createFileExplorerWatchRefreshScheduler({
      refreshTree: () => refreshTreeRef.current(),
      refreshDir: (dirPath) => refreshDirRef.current(dirPath),
      // Expanded paths must exactly match resolved cache keys or full refresh may falsely claim coverage; normalize only the root.
      isCoveredByFullRefresh: (dirPath) =>
        normalizeRuntimePathForComparison(dirPath) ===
          normalizeRuntimePathForComparison(currentWorktreePath) ||
        expandedRef.current.has(dirPath),
      dirConcurrency: fileExplorerRefreshConcurrency(owner)
    })
    activeResyncByWatchKey.set(currentWatchKey, scheduler.requestFullRefresh)

    if (resyncWatchKeys.delete(currentWatchKey)) {
      scheduler.requestFullRefresh()
    }

    function processPayload(payload: FsChangedPayload): void {
      processFileExplorerFsPayload({
        payload,
        currentWorktreePath,
        worktreeId: currentWorktreeId,
        cache: dirCacheRef.current,
        expanded: expandedRef.current,
        followSymlinks: useAppStore.getState().settings?.followSymlinkedDirectories ?? false,
        setDirCache,
        setSelectedPath,
        refreshDir: scheduler.requestDirRefresh,
        refreshTree: scheduler.requestFullRefresh
      })
    }

    processPayloadRef.current = processPayload

    let disposed = false

    const handleFsChanged = (payload: FsChangedPayload): void => {
      if (disposed) {
        if (
          normalizeRuntimePathForComparison(payload.worktreePath) ===
          normalizeRuntimePathForComparison(currentWorktreePath)
        ) {
          const requestActiveResync = activeResyncByWatchKey.get(currentWatchKey)
          if (requestActiveResync) {
            requestActiveResync()
          } else {
            resyncWatchKeys.add(currentWatchKey)
          }
        }
        return
      }
      if (
        normalizeRuntimePathForComparison(payload.worktreePath) !==
        normalizeRuntimePathForComparison(currentWorktreePath)
      ) {
        return
      }
      // Defer during inline input and both drag types so reconciliation cannot shift rows.
      if (
        inlineInputRef.current !== null ||
        dragSourceRef.current !== null ||
        isNativeDragOverRef.current
      ) {
        deferredRef.current.push(payload)
        return
      }

      processPayload(payload)
    }

    const handleRuntimeChange = (
      event: WindowEventMap[typeof ORCA_WORKTREE_FILE_CHANGE_EVENT]
    ): void => {
      if (event.detail.runtimeEnvironmentId === activeRuntimeEnvironmentId) {
        handleFsChanged(event.detail.payload)
      }
    }
    // IPC trees also need synthesized catch-up after watch reacquisition.
    const handleCatchUp = (event: WindowEventMap[typeof ORCA_WORKTREE_FILE_CHANGE_EVENT]): void => {
      if (
        event.detail.runtimeEnvironmentId === null &&
        isWorktreeCatchUpPayload(event.detail.payload)
      ) {
        handleFsChanged(event.detail.payload)
      }
    }
    let unsubscribeListener: (() => void) | null = null
    if (activeRuntimeEnvironmentId?.trim() && activeWorktreeId) {
      // The app watcher owns recovery; a separate stream would strand this consumer after reconnect.
      window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleRuntimeChange)
    } else {
      unsubscribeListener = window.api.fs.onFsChanged(handleFsChanged)
      window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleCatchUp)
    }

    return () => {
      disposed = true
      window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleRuntimeChange)
      window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleCatchUp)
      unsubscribeListener?.()
      if (activeResyncByWatchKey.get(currentWatchKey) === scheduler.requestFullRefresh) {
        activeResyncByWatchKey.delete(currentWatchKey)
      }
      const hadDeferredEvents = deferredRef.current.length > 0
      if (scheduler.cancel() || hadDeferredEvents) {
        // The tree cache survives Files being hidden, so remember work canceled after receipt.
        resyncWatchKeys.add(currentWatchKey)
      }
      deferredRef.current = []
      processPayloadRef.current = null
    }
  }, [worktreePath, activeWorktreeId, activeRuntimeEnvironmentId, setDirCache, setSelectedPath])

  useEffect(() => {
    if (
      inlineInput === null &&
      dragSourcePath === null &&
      !isNativeDragOver &&
      deferredRef.current.length > 0
    ) {
      const deferred = deferredRef.current.splice(0)
      if (processPayloadRef.current) {
        for (const payload of deferred) {
          processPayloadRef.current(payload)
        }
      }
    }
  }, [inlineInput, dragSourcePath, isNativeDragOver])
}
