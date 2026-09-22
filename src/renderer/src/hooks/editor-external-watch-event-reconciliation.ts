import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { basename } from '@/lib/path'
import {
  canAutoSaveOpenFile,
  isExternalReloadableEditorTab
} from '@/components/editor/editor-autosave'
import { indexEditorExternalWatchBatchPaths } from '@/components/editor/editor-external-watch-path-index'
import { getRecentSelfWrite } from '@/components/editor/editor-self-write-registry'
import {
  hasActiveEditorPathMoves,
  isActiveMoveSourcePath
} from '@/components/editor/editor-path-move-inflight'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'
import {
  ORCA_WORKTREE_FILE_CHANGE_EVENT,
  type WorktreeFileChangeEventDetail
} from './worktree-file-change-event'
import {
  getLocalWindowsWslAliasOption,
  getOpenFileRuntimeOwner,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'
import {
  scheduleDebouncedEditorExternalReload,
  scheduleEditorChangedOnDiskMark,
  scheduleEditorSelfMoveEchoVerification,
  scheduleSelfWriteAwareEditorExternalReload,
  type EditorExternalWatchNotification
} from './editor-external-watch-disk-verification'

// Why: macOS atomic writes split delete→create across payloads; debounce deletion so a same-path create cancels the tombstone before it paints.
const EXTERNAL_MUTATION_DEBOUNCE_MS = 75

type PendingDeleteTimer = {
  fileId: string
  timer: ReturnType<typeof setTimeout>
}

export function buildEditorExternalWatchEventHandler(
  findTarget: (
    worktreePath: string,
    runtimeEnvironmentId: string | null
  ) => EditorExternalWatchTarget | undefined
): {
  handleFsChanged: (payload: FsChangedPayload, runtimeEnvironmentId?: string | null) => void
  dispose: () => void
} {
  const pendingDeletes = new Map<string, PendingDeleteTimer>()
  const pendingKey = (
    worktreeId: string,
    runtimeEnvironmentId: string | null,
    absolutePath: string
  ): string => `${worktreeId}::${runtimeEnvironmentId ?? 'client'}::${absolutePath}`

  const handleFsChanged = (
    payload: FsChangedPayload,
    runtimeEnvironmentId: string | null = null
  ): void => {
    const target = findTarget(payload.worktreePath, runtimeEnvironmentId)
    if (!target) {
      return
    }
    // Why: this app-level hook owns watcher subscriptions; other consumers listen here so they don't fight over watch/unwatch ownership.
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent<WorktreeFileChangeEventDetail>(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
          detail: { payload, runtimeEnvironmentId: target.runtimeEnvironmentId }
        })
      )
    }

    // Why: one batch index keeps local WSL alias normalization out of event×tab loops.
    const openFilesAtStart = useAppStore.getState().openFiles
    const batchPaths = indexEditorExternalWatchBatchPaths(payload, openFilesAtStart, {
      worktreeId: target.worktreeId,
      worktreePath: target.worktreePath,
      runtimeEnvironmentId: target.runtimeEnvironmentId,
      ...getLocalWindowsWslAliasOption(target)
    })
    const createOrUpdatePaths = batchPaths.createOrUpdatePaths
    for (const createdPath of createOrUpdatePaths.keys()) {
      const key = pendingKey(target.worktreeId, target.runtimeEnvironmentId, createdPath)
      const existing = pendingDeletes.get(key)
      if (existing) {
        clearTimeout(existing.timer)
        pendingDeletes.delete(key)
      }
    }

    const deletedOpenEditorsRaw = batchPaths.deletedOpenEditors
    // Only pay the per-id lookup to suppress a move's own source-delete while a move is live; otherwise the batch stays O(deletes).
    const deletedOpenEditors = hasActiveEditorPathMoves()
      ? deletedOpenEditorsRaw.filter(
          ({ file }) =>
            !isActiveMoveSourcePath(target.worktreeId, target.runtimeEnvironmentId, file.filePath)
        )
      : deletedOpenEditorsRaw
    const deletedOpenEditorIds = deletedOpenEditors.map(({ file }) => file.id)
    const hasPairedCreate =
      deletedOpenEditorIds.length > 0 &&
      hasRenameCorrelatedCreate(payload, target.worktreeId, deletedOpenEditorIds, openFilesAtStart)
    if (deletedOpenEditorIds.length > 0) {
      if (hasPairedCreate) {
        const setExternalMutation = useAppStore.getState().setExternalMutation
        for (const fileId of deletedOpenEditorIds) {
          setExternalMutation(fileId, 'renamed')
        }
      } else {
        for (const { file, normalizedDeletePath } of deletedOpenEditors) {
          const key = pendingKey(
            target.worktreeId,
            target.runtimeEnvironmentId,
            normalizedDeletePath
          )
          const existing = pendingDeletes.get(key)
          if (existing) {
            clearTimeout(existing.timer)
            pendingDeletes.delete(key)
          }
          const timer = setTimeout(() => {
            pendingDeletes.delete(key)
            // Why: the debounce window lets the tab close or leave edit mode, so re-check before writing to avoid tombstoning a stale tab.
            const state = useAppStore.getState()
            const stillEditing = state.openFiles.some(
              (candidate) => candidate.id === file.id && candidate.mode === 'edit'
            )
            if (stillEditing) {
              state.setExternalMutation(file.id, 'deleted')
            }
          }, EXTERNAL_MUTATION_DEBOUNCE_MS)
          pendingDeletes.set(key, { fileId: file.id, timer })
        }
      }
    }

    // Why: a reappearing file clears deleted/renamed tombstones, but a changed mark resolves only through reload/save.
    if (createOrUpdatePaths.size > 0) {
      const state = useAppStore.getState()
      for (const file of state.openFiles) {
        if (
          file.worktreeId === target.worktreeId &&
          getOpenFileRuntimeOwner(file) === target.runtimeEnvironmentId &&
          (file.mode === 'edit' || file.mode === 'markdown-preview') &&
          (file.externalMutation === 'deleted' || file.externalMutation === 'renamed') &&
          batchPaths.matchesCreateOrUpdate(file)
        ) {
          state.setExternalMutation(file.id, null)
        }
      }
    }

    if (payload.events.some((event) => event.kind === 'overflow')) {
      // Why: overflow omits paths, so reload clean tabs and clear tombstones that may have been resurrected during the overrun.
      for (const notification of collectOverflowEditorExternalReloadTargets(target)) {
        scheduleDebouncedEditorExternalReload(notification)
      }
      return
    }
    if (batchPaths.changes.length === 0) {
      return
    }

    for (const change of batchPaths.changes) {
      const matching = batchPaths.matchingOpenFiles(change)
      // Why: most watched paths match no open file, and the notification below is only ever read
      // past this point — building it first allocates (and dictionary-modes) it for nothing.
      if (matching.length === 0 && !batchPaths.hasCombinedDiffConsumer) {
        continue
      }
      const notification: EditorExternalWatchNotification = {
        worktreeId: target.worktreeId,
        worktreePath: target.worktreePath,
        relativePath: change.relativePath,
        runtimeEnvironmentId: target.runtimeEnvironmentId,
        ...getLocalWindowsWslAliasOption(target)
      }
      Object.defineProperty(notification, 'indexedOpenFiles', {
        value: {
          matches: (openFiles: OpenFile[]) => batchPaths.matchingOpenFiles(change, openFiles)
        }
      })
      if (matching.length === 0) {
        scheduleDebouncedEditorExternalReload(notification)
        continue
      }
      const dirtyMatches = matching.filter((file) => file.isDirty)
      if (dirtyMatches.length > 0) {
        const dirtyIds = dirtyMatches
          .filter((file) => canAutoSaveOpenFile(file))
          .map((file) => file.id)
        let isSelfMoveEcho = false
        if (dirtyMatches.some((file) => file.pendingSelfMoveEcho)) {
          const normalizedAbsolutePath = normalizeRuntimePathForComparison(change.absolutePath)
          isSelfMoveEcho = dirtyMatches.some(
            (file) =>
              file.pendingSelfMoveEcho &&
              normalizeRuntimePathForComparison(file.pendingSelfMoveEcho.targetPath) ===
                normalizedAbsolutePath
          )
        }
        if (isSelfMoveEcho) {
          scheduleEditorSelfMoveEchoVerification(target, dirtyIds, true)
        } else {
          scheduleEditorChangedOnDiskMark(target, notification, dirtyIds)
        }
        if (dirtyMatches.length === matching.length) {
          if (batchPaths.hasCombinedDiffConsumer) {
            scheduleDebouncedEditorExternalReload(notification)
          }
          continue
        }
      }
      const recentSelfWrite = getRecentSelfWrite(change.absolutePath, target.runtimeEnvironmentId)
      if (recentSelfWrite) {
        scheduleSelfWriteAwareEditorExternalReload(
          target,
          notification,
          matching[0],
          recentSelfWrite
        )
        continue
      }
      scheduleDebouncedEditorExternalReload(notification)
    }
  }

  const dispose = (): void => {
    for (const pending of pendingDeletes.values()) {
      clearTimeout(pending.timer)
    }
    pendingDeletes.clear()
  }

  return { handleFsChanged, dispose }
}

export function collectOverflowEditorExternalReloadTargets(
  target: Pick<EditorExternalWatchTarget, 'worktreeId' | 'worktreePath'> &
    Partial<
      Pick<
        EditorExternalWatchTarget,
        'connectionId' | 'runtimeEnvironmentId' | 'allowLocalWindowsWslAliases'
      >
    >
): EditorExternalWatchNotification[] {
  const state = useAppStore.getState()
  const notifications: EditorExternalWatchNotification[] = []
  for (const file of state.openFiles) {
    if (
      file.worktreeId !== target.worktreeId ||
      getOpenFileRuntimeOwner(file) !== (target.runtimeEnvironmentId ?? null) ||
      !isExternalReloadableEditorTab(file) ||
      file.isDirty
    ) {
      continue
    }
    if (file.externalMutation) {
      state.setExternalMutation(file.id, null)
    }
    notifications.push({
      worktreeId: target.worktreeId,
      worktreePath: target.worktreePath,
      relativePath: file.relativePath,
      runtimeEnvironmentId: target.runtimeEnvironmentId ?? null,
      ...getLocalWindowsWslAliasOption(target)
    })
  }
  return notifications
}

function hasRenameCorrelatedCreate(
  payload: FsChangedPayload,
  worktreeId: string,
  deletedOpenEditorIds: string[],
  openFiles: OpenFile[]
): boolean {
  if (deletedOpenEditorIds.length === 0) {
    return false
  }
  const deletedIdSet = new Set(deletedOpenEditorIds)
  const deletedBasenames = new Set<string>()
  for (const file of openFiles) {
    if (
      file.worktreeId !== worktreeId ||
      (file.mode !== 'edit' && file.mode !== 'markdown-preview') ||
      !deletedIdSet.has(file.id)
    ) {
      continue
    }
    deletedBasenames.add(basename(file.filePath))
  }
  if (deletedBasenames.size === 0) {
    return false
  }
  return payload.events.some(
    (event) =>
      event.kind === 'create' &&
      event.isDirectory !== true &&
      deletedBasenames.has(basename(event.absolutePath))
  )
}
