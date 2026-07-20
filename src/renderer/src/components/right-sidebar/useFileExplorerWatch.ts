import { useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { FsChangedPayload } from '../../../../shared/types'
import type { DirCache } from './file-explorer-types'
import type { InlineInput } from './FileExplorerRow'
import { joinPath, normalizeRelativePath, dirname } from '@/lib/path'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'
import {
  purgeDirCacheSubtree,
  purgeExpandedDirsSubtree,
  clearStalePendingReveal
} from './file-explorer-watcher-reconcile'
import { useAppStore } from '@/store'
import { subscribeRuntimeFileChanges } from '@/runtime/runtime-file-client'
import type { AppState } from '@/store/types'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'

type UseFileExplorerWatchParams = {
  worktreePath: string | null
  activeWorktreeId: string | null
  dirCache: Record<string, DirCache>
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  expanded: Set<string>
  setSelectedPath: Dispatch<SetStateAction<string | null>>
  refreshDir: (dirPath: string) => Promise<void>
  refreshTree: () => Promise<void>
  inlineInput: InlineInput | null
  dragSourcePath: string | null
  isNativeDragOver: boolean
}

export function getExternalFileChangeRelativePath(
  worktreePath: string,
  absolutePath: string,
  isDirectory: boolean | undefined
): string | null {
  if (isDirectory === true) {
    return null
  }

  const relativePath = relativePathInsideRoot(worktreePath, absolutePath)
  if (relativePath === null || relativePath === '') {
    return null
  }

  // Why: EditorPanel reloads tabs only from a worktree-relative path, not the watcher's absolute one; normalize or contents go stale.
  return normalizeRelativePath(relativePath)
}

export function canonicalizeFileExplorerWatchPath(
  worktreePath: string,
  absolutePath: string
): string | null {
  const relativePath = relativePathInsideRoot(worktreePath, absolutePath)
  if (relativePath === null) {
    return null
  }

  const rootPath = normalizeExplorerAbsolutePath(worktreePath)
  return relativePath === '' ? rootPath : joinPath(rootPath, relativePath)
}

function normalizeExplorerAbsolutePath(path: string): string {
  if (path === '/' || /^[A-Za-z]:[\\/]$/.test(path)) {
    return path
  }
  return path.replace(/[\\/]+$/, '')
}

export function payloadRequiresDeferredTreeRefresh(
  payload: FsChangedPayload,
  currentWorktreePath: string
): boolean {
  if (
    normalizeRuntimePathForComparison(payload.worktreePath) !==
    normalizeRuntimePathForComparison(currentWorktreePath)
  ) {
    return false
  }

  return payload.events.some((evt) => evt.kind === 'rename')
}

export function getFileExplorerWatchRuntimeEnvironmentId(
  state: Pick<AppState, 'repos' | 'settings' | 'worktreesByRepo'>,
  activeWorktreeId: string | null
): string | null {
  return getRuntimeEnvironmentIdForWorktree(state, activeWorktreeId)
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
  isNativeDragOver
}: UseFileExplorerWatchParams): void {
  // Why: subscriptions follow the selected worktree; host focus is only a legacy default, not an ownership signal.
  const activeRuntimeEnvironmentId = useAppStore((s) =>
    getFileExplorerWatchRuntimeEnvironmentId(s, activeWorktreeId)
  )

  // Keep refs for handler-accessed values so the IPC listener isn't re-subscribed on every render.
  const dirCacheRef = useRef(dirCache)
  dirCacheRef.current = dirCache

  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  const worktreeIdRef = useRef(activeWorktreeId)
  worktreeIdRef.current = activeWorktreeId

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

  // Why: a ref bridges processPayload to the flush effect so it can replay deferred payloads without re-subscribing (design §6.2).
  const processPayloadRef = useRef<((payload: FsChangedPayload) => void) | null>(null)

  // Why: one atomic effect avoids a cleanup-ordering race that drops events on rapid worktree switches (review issue §3).
  useEffect(() => {
    if (!worktreePath) {
      return
    }

    const currentWorktreePath = worktreePath

    function processPayload(payload: FsChangedPayload): void {
      // Why: stale batched events from the old worktree can arrive after a switch and corrupt dirCache (design §3).
      if (
        normalizeRuntimePathForComparison(payload.worktreePath) !==
        normalizeRuntimePathForComparison(currentWorktreePath)
      ) {
        return
      }

      const wtId = worktreeIdRef.current
      if (!wtId) {
        return
      }

      const cache = dirCacheRef.current
      const exp = expandedRef.current

      // Collect directories that need refreshing
      const dirsToRefresh = new Set<string>()
      let needsFullRefresh = false

      for (const evt of payload.events) {
        if (evt.kind === 'overflow') {
          needsFullRefresh = true
          break
        }

        const normalizedPath = canonicalizeFileExplorerWatchPath(
          currentWorktreePath,
          evt.absolutePath
        )
        if (!normalizedPath) {
          continue
        }

        if (evt.kind === 'delete') {
          // Why: watcher can't report isDirectory for deletes; a dirCache key means it was an expanded dir (design §4.4).
          const wasDirectory = normalizedPath in cache

          if (wasDirectory) {
            purgeDirCacheSubtree(setDirCache, normalizedPath)
            purgeExpandedDirsSubtree(wtId, normalizedPath)
          }

          // Clear pendingExplorerReveal if it targets the deleted path or a descendant.
          clearStalePendingReveal(normalizedPath)

          // Clear selectedPath if it points into the deleted subtree
          setSelectedPath((prev) => {
            if (
              prev &&
              normalizeRuntimePathForComparison(prev) ===
                normalizeRuntimePathForComparison(normalizedPath)
            ) {
              return null
            }
            if (prev && wasDirectory && isPathInsideOrEqual(normalizedPath, prev)) {
              return null
            }
            return prev
          })

          // Invalidate the parent directory
          const parent = normalizeExplorerAbsolutePath(dirname(normalizedPath))
          if (parent in cache) {
            dirsToRefresh.add(parent)
          }
        } else if (evt.kind === 'create') {
          // Invalidate the parent directory
          const parent = normalizeExplorerAbsolutePath(dirname(normalizedPath))
          if (parent in cache) {
            dirsToRefresh.add(parent)
          }
        } else if (evt.kind === 'update') {
          // Why: only directory updates invalidate; file-content updates are ignored in v1 (design §6.1).
          if (evt.isDirectory === true) {
            if (normalizedPath in cache) {
              dirsToRefresh.add(normalizedPath)
            }
          }
        }
        // 'rename' is deferred to v2 (design §5.3)
      }

      if (needsFullRefresh) {
        void refreshTreeRef.current()
        return
      }

      // Only refresh dirs already loaded and reachable (root, expanded, or cached).
      for (const dirPath of dirsToRefresh) {
        if (
          dirPath === normalizeExplorerAbsolutePath(currentWorktreePath) ||
          exp.has(dirPath) ||
          dirPath in dirCacheRef.current
        ) {
          void refreshDirRef.current(dirPath)
        }
      }
    }

    // Why: expose processPayload to the flush effect so it can replay deferred payloads without re-subscribing.
    processPayloadRef.current = processPayload

    const handleFsChanged = (payload: FsChangedPayload): void => {
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

    let disposed = false
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
      const requiresFullRefresh = worktreePath
        ? deferred.some((payload) => payloadRequiresDeferredTreeRefresh(payload, worktreePath))
        : false
      // Why: replay deferred payloads so the tree cache reconciles to disk after inline input or drag ends (design §6.2).
      if (processPayloadRef.current) {
        for (const payload of deferred) {
          processPayloadRef.current(payload)
        }
      }
      // Why: create/delete/update already replayed above; only kinds this reconciler can't apply (rename) pay the full-tree refresh.
      if (requiresFullRefresh) {
        void refreshTreeRef.current()
      }
    }
  }, [inlineInput, dragSourcePath, isNativeDragOver, worktreePath])
}
