import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import type {
  DirCache,
  FileExplorerOperationOwner,
  FileExplorerTreeRefreshOutcome
} from './file-explorer-types'
import type { InlineInput } from './file-explorer-inline-input-row'
import { useAppStore } from '@/store'
import { subscribeRuntimeFileChanges } from '@/runtime/runtime-file-client'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import {
  getFileExplorerOperationOwner,
  getFileExplorerOperationOwnerFromState,
  type FileExplorerOwnerState
} from './file-explorer-operation-owner'
import { fileExplorerRefreshConcurrency } from './file-explorer-refresh-concurrency'
import { createFileExplorerWatchRefreshScheduler } from './file-explorer-watch-refresh-scheduler'
import { processFileExplorerFsPayload } from './file-explorer-watch-reconcile'

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
    settings: state.settings,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
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

/**
 * Reconciles File Explorer state on filesystem events for the active worktree.
 *
 * Why: `useEditorExternalWatch` owns the watch IPC lifecycle; this hook only subscribes to fs:changed for tree-cache reconciliation.
 */
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
  // Why: subscriptions follow the selected worktree; host focus is only a legacy default, not an ownership signal.
  const activeRuntimeEnvironmentId = useAppStore((s) =>
    getFileExplorerWatchRuntimeEnvironmentId(s, activeWorktreeId, operationOwner)
  )

  // Keep refs for handler-accessed values so the IPC listener isn't re-subscribed on every render.
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

  // Why: refs keep the effect from re-subscribing when refreshTree's identity changes on expand/collapse (review issue §1).
  const refreshDirRef = useRef(refreshDir)
  refreshDirRef.current = refreshDir

  const refreshTreeRef = useRef(refreshTree)
  refreshTreeRef.current = refreshTree

  // Deferred events queue: events that arrive during inline input or drag
  const deferredRef = useRef<FsChangedPayload[]>([])
  const resyncWatchKeysRef = useRef(new Set<string>())
  const activeResyncByWatchKeyRef = useRef(new Map<string, () => void>())

  // Why: a ref bridges processPayload to the flush effect so it can replay deferred payloads without re-subscribing (design §6.2).
  const processPayloadRef = useRef<((payload: FsChangedPayload) => void) | null>(null)

  // Why: one atomic effect avoids a cleanup-ordering race that drops events on rapid worktree switches (review issue §3).
  useEffect(() => {
    // Why require a worktree id: it is half of every watch key, and reconciliation already needs it —
    // a null-keyed subscription would only park resync state no correctly-keyed one can consume.
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

    // Why: one scheduler per subscription covers BOTH remote transports (the
    // Electron fs:changed bus and the runtime-RPC subscription below), and its
    // lifetime is tied to the watched worktree so a switch can't refresh the
    // previous root.
    const owner = getFileExplorerOperationOwner(currentWorktreeId)
    const scheduler = createFileExplorerWatchRefreshScheduler({
      refreshTree: () => refreshTreeRef.current(),
      refreshDir: (dirPath) => refreshDirRef.current(dirPath),
      // Why exact-match on `expanded`, not a normalized compare: dirPath already arrives as a
      // resolved dirCache key (resolveCachedDirPath), and refreshTree re-reads dirCache under the
      // verbatim expanded strings — a differently-spelled key it never wrote would be reported
      // covered and left stale. Only the root is normalized: it is keyed by worktreePath.
      isCoveredByFullRefresh: (dirPath) =>
        normalizeRuntimePathForComparison(dirPath) ===
          normalizeRuntimePathForComparison(currentWorktreePath) ||
        expandedRef.current.has(dirPath),
      dirConcurrency: fileExplorerRefreshConcurrency(owner),
      // Why 0ms for every transport: each producer already flushes on the shared
      // WATCH_BATCH_* window — local/SSH via filesystem-watcher, runtime files.watch via
      // createFileWatchEventBatcher — so a second 150ms here only adds latency, not coalescing.
      // A new transport must batch at the producer before joining this path.
      trailingMs: 0,
      maxWaitMs: 0
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
        setDirCache,
        setSelectedPath,
        refreshDir: scheduler.requestDirRefresh,
        refreshTree: scheduler.requestFullRefresh
      })
    }

    // Why: expose processPayload to the flush effect so it can replay deferred payloads without re-subscribing.
    processPayloadRef.current = processPayload

    // Declared before handleFsChanged so its `disposed` read can never hit the temporal dead zone.
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
      // Why: defer refreshes during inline input/drag so rows don't shift; native drags only set isNativeDragOver (design §6.2).
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

    let unsubscribeListener: (() => void) | null = null
    if (activeRuntimeEnvironmentId?.trim() && activeWorktreeId) {
      // Why: remote runtime watch events don't enter the local Electron fs:changed bus, so subscribe directly.
      void subscribeRuntimeFileChanges(
        {
          settings: { activeRuntimeEnvironmentId },
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId: undefined
        },
        handleFsChanged,
        (err) => {
          console.warn('[filesystem-watch] failed to subscribe to runtime file changes', {
            worktreeId: activeWorktreeId,
            worktreePath,
            error: err.message
          })
        }
      )
        .then((unsubscribe) => {
          if (disposed) {
            unsubscribe()
            return
          }
          unsubscribeListener = unsubscribe
        })
        .catch((err) => {
          console.warn('[filesystem-watch] failed to subscribe to runtime file changes', {
            worktreeId: activeWorktreeId,
            worktreePath,
            error: err instanceof Error ? err.message : String(err)
          })
        })
    } else {
      unsubscribeListener = window.api.fs.onFsChanged(handleFsChanged)
    }

    return () => {
      disposed = true
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

  // ── Flush deferred events when interaction ends ────────────────────
  useEffect(() => {
    if (
      inlineInput === null &&
      dragSourcePath === null &&
      !isNativeDragOver &&
      deferredRef.current.length > 0
    ) {
      const deferred = deferredRef.current.splice(0)
      // Why: replay deferred payloads so the tree cache reconciles to disk after inline input or drag ends (design §6.2).
      if (processPayloadRef.current) {
        for (const payload of deferred) {
          processPayloadRef.current(payload)
        }
      }
    }
  }, [inlineInput, dragSourcePath, isNativeDragOver])
}
