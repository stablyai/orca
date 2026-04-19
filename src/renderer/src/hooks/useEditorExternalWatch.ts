/* eslint-disable max-lines -- Why: the editor external-watch hook co-locates
   target diffing, fs:changed dispatch, tombstone coalescing, and rename
   correlation so the end-to-end event-to-store mutation contract stays
   readable in one file. */
import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { basename } from '@/lib/path'
import { normalizeAbsolutePath } from '@/components/right-sidebar/file-explorer-paths'
import { getExternalFileChangeRelativePath } from '@/components/right-sidebar/useFileExplorerWatch'
import {
  getOpenFilesForExternalFileChange,
  notifyEditorExternalFileChange
} from '@/components/editor/editor-autosave'
import type { FsChangedPayload } from '../../../shared/types'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { OpenFile } from '@/store/slices/editor'

// Why: atomic-write patterns (Claude Code's Edit tool, editors like vim,
// VSCode) land as a short burst of `update` events — or `delete + create` on
// renamers — within a few milliseconds for the same path. Dispatching an
// `ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT` per raw event fan-outs into N full
// `setContent` + `normalizeSoftBreaks` doc rebuilds per mounted EditorPanel,
// which under split-pane + large markdown is enough to wedge the renderer
// and black out the window (issue #826). Coalescing per (worktreeId + path)
// on a short debounce collapses that burst into one reload notification.
const EXTERNAL_RELOAD_DEBOUNCE_MS = 75
const pendingExternalReloadTimers = new Map<string, number>()

function scheduleDebouncedExternalReload(notification: {
  worktreeId: string
  worktreePath: string
  relativePath: string
}): void {
  const key = `${notification.worktreeId}::${notification.relativePath}`
  const existing = pendingExternalReloadTimers.get(key)
  if (existing !== undefined) {
    window.clearTimeout(existing)
  }
  const handle = window.setTimeout(() => {
    pendingExternalReloadTimers.delete(key)
    notifyEditorExternalFileChange(notification)
  }, EXTERNAL_RELOAD_DEBOUNCE_MS)
  pendingExternalReloadTimers.set(key, handle)
}

type WatchedTarget = {
  worktreeId: string
  worktreePath: string
  connectionId: string | undefined
}

type ExternalWatchNotification = {
  worktreeId: string
  worktreePath: string
  relativePath: string
}

// Why: macOS atomic writes (Claude Code Edit, vim :w, VSCode save) deliver a
// delete event immediately followed by a create event for the same path. When
// those two land in separate fs:changed payloads a few ms apart, the tab
// flickers struck-through for one render before the follow-up create clears
// it. Debouncing just the 'deleted' signal — keyed by absolute path — lets a
// same-path create in the next payload cancel the tombstone before it ever
// paints. A naked delete still resolves to 'deleted' after the window. The
// in-payload rename correlation is unchanged.
const EXTERNAL_MUTATION_DEBOUNCE_MS = 75

type PendingDeleteTimer = {
  fileId: string
  timer: ReturnType<typeof setTimeout>
}

/**
 * Subscribes to filesystem watcher events for every worktree that currently
 * has an editor tab open, and notifies the editor to reload clean tabs when
 * their on-disk contents change.
 *
 * Why: the File Explorer panel's watcher hook is unmounted whenever the user
 * switches the right sidebar to Source Control / Checks / Search. Relying on
 * that panel to dispatch editor-reload notifications means terminal edits go
 * unnoticed while any non-Explorer sidebar tab is active. Lifting the
 * editor-reload subscription to an always-mounted hook mirrors VSCode's
 * `TextFileEditorModelManager`, which subscribes to `fileService
 * .onDidFilesChange` once at the workbench level and reloads non-dirty models
 * regardless of which UI panel is visible.
 */
export function useEditorExternalWatch(): void {
  const openFiles = useAppStore((s) => s.openFiles)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)

  // Why: unify the target computation and the dependency key into one memo so
  // there's a single source of truth. The derived string key drives the
  // watch-diff effect; the array itself is what the effect actually iterates.
  const { targets, targetsKey } = useMemo(() => {
    const ids = new Set<string>()
    // Why: watch every worktree that has an editor tab open, so terminal edits
    // in any of those roots reach the editor. Also watch the active worktree
    // even when it has no open files — otherwise the File Explorer's tree
    // reconciliation loses its event stream the moment the last tab for that
    // worktree is closed.
    for (const f of openFiles) {
      ids.add(f.worktreeId)
    }
    if (activeWorktreeId) {
      ids.add(activeWorktreeId)
    }
    const nextTargets: WatchedTarget[] = []
    const parts: string[] = []
    for (const id of Array.from(ids).sort()) {
      const wt = findWorktreeById(worktreesByRepo, id)
      if (!wt) {
        continue
      }
      nextTargets.push({
        worktreeId: id,
        worktreePath: wt.path,
        connectionId: getConnectionId(id) ?? undefined
      })
      parts.push(`${id}::${wt.path}`)
    }
    return { targets: nextTargets, targetsKey: parts.join('|') }
  }, [openFiles, worktreesByRepo, activeWorktreeId])

  const targetsRef = useRef<WatchedTarget[]>([])
  const latestTargetsRef = useRef<WatchedTarget[]>(targets)
  latestTargetsRef.current = targets

  // Why: diff previous vs next targets so unchanged worktrees keep their
  // existing subscription. Tearing down every subscription on each targetsKey
  // change (e.g. opening/closing a tab in an already-watched worktree) causes
  // a watcher churn that can drop events emitted during the gap.
  useEffect(() => {
    const nextTargets = latestTargetsRef.current
    const prev = targetsRef.current
    const prevIds = new Set(prev.map((t) => t.worktreeId))
    const nextIds = new Set(nextTargets.map((t) => t.worktreeId))
    const removed = prev.filter((t) => !nextIds.has(t.worktreeId))
    const added = nextTargets.filter((t) => !prevIds.has(t.worktreeId))

    for (const target of removed) {
      void window.api.fs.unwatchWorktree({
        worktreePath: target.worktreePath,
        connectionId: target.connectionId
      })
    }
    for (const target of added) {
      void window.api.fs.watchWorktree({
        worktreePath: target.worktreePath,
        connectionId: target.connectionId
      })
    }
    targetsRef.current = nextTargets
    // Why: this effect is intentionally differential — it does not unwatch on
    // cleanup. Final unmount unwatching lives in the separate [] effect below
    // so that re-running on targetsKey changes doesn't tear down everything.
  }, [targetsKey])

  // Why: the fs:changed subscription and the final unmount unwatch are
  // independent of which worktrees are currently watched. Keeping them in a
  // single always-mounted effect avoids re-subscribing on every targetsKey
  // change (which would otherwise miss events fired during re-subscription).
  useEffect(() => {
    const { handleFsChanged, dispose } = createExternalWatchEventHandler((worktreePath) =>
      targetsRef.current.find(
        (t) => normalizeAbsolutePath(t.worktreePath) === normalizeAbsolutePath(worktreePath)
      )
    )
    const unsubscribe = window.api.fs.onFsChanged(handleFsChanged)

    return () => {
      unsubscribe()
      dispose()
      // Why: final unmount must tear down every outstanding subscription.
      // The differential watch effect above intentionally never unwatches on
      // cleanup, so this is the only place that clears them.
      for (const target of targetsRef.current) {
        void window.api.fs.unwatchWorktree({
          worktreePath: target.worktreePath,
          connectionId: target.connectionId
        })
      }
      targetsRef.current = []
      // Why: deliberately do NOT clear pendingExternalReloadTimers here.
      // The map is module-scoped, so in React StrictMode (dev) the first
      // mount's cleanup would otherwise drop timers scheduled by the second
      // mount. A late `notifyEditorExternalFileChange` dispatch after unmount
      // is also harmless — it's a window event with no EditorPanel listeners
      // attached once the editor tree is torn down.
    }
  }, [])
}

/**
 * Builds the fs:changed handler used by `useEditorExternalWatch`. Exported
 * so tests can drive the full event pipeline — including the debounced
 * tombstone coalescer — without mounting the hook. See
 * `EXTERNAL_MUTATION_DEBOUNCE_MS` for the macOS atomic-write rationale.
 */
export function createExternalWatchEventHandler(
  findTarget: (worktreePath: string) => WatchedTarget | undefined
): {
  handleFsChanged: (payload: FsChangedPayload) => void
  dispose: () => void
} {
  // Why: coalesce 'deleted' tombstones across back-to-back payloads so a
  // same-path create arriving in the next payload (macOS atomic write)
  // cancels the tombstone before the tab flashes. Keyed by normalized
  // absolute path, scoped per-target. See EXTERNAL_MUTATION_DEBOUNCE_MS.
  const pendingDeletes = new Map<string, PendingDeleteTimer>()
  const pendingKey = (worktreeId: string, absolutePath: string): string =>
    `${worktreeId}::${absolutePath}`

  const handleFsChanged = (payload: FsChangedPayload): void => {
    const target = findTarget(payload.worktreePath)
    if (!target) {
      return
    }

    // Why: collect create/update paths first so we can cancel any pending
    // same-path delete before scheduling a new one. This is what absorbs
    // the macOS atomic-write delete→create split across two payloads.
    const createOrUpdatePaths = new Set<string>()
    for (const evt of payload.events) {
      if (evt.isDirectory === true) {
        continue
      }
      if (evt.kind === 'create' || evt.kind === 'update') {
        createOrUpdatePaths.add(normalizeAbsolutePath(evt.absolutePath))
      }
    }
    for (const createdPath of createOrUpdatePaths) {
      const key = pendingKey(target.worktreeId, createdPath)
      const existing = pendingDeletes.get(key)
      if (existing) {
        clearTimeout(existing.timer)
        pendingDeletes.delete(key)
      }
    }

    // Why: when an external process removes (or `git mv`s) a file that's
    // open in the editor, keep the tab alive and mark it as deleted/renamed
    // so the user can see the mutation and still access their in-memory
    // content. A paired create-event in the same batch signals a rename;
    // a lone delete is a hard delete. Resurrection (same path comes back
    // on disk) clears the mark further down.
    // Why: snapshot openFiles once so the delete/rename helpers below share a
    // consistent view and we don't pay N store reads per payload.
    const openFilesAtStart = useAppStore.getState().openFiles
    const deletedOpenEditorIds = collectDeletedOpenEditorIds(
      payload,
      target.worktreeId,
      openFilesAtStart
    )
    // Why: correlate creates to deletes by basename OR parent directory to
    // avoid mislabelling unrelated create+delete pairs in a batched payload
    // as "renamed". When we can't correlate, default to 'deleted' — that's
    // the least misleading fallback (it preserves in-memory content and
    // doesn't claim a rename target that doesn't exist).
    const hasPairedCreate =
      deletedOpenEditorIds.length > 0 &&
      hasRenameCorrelatedCreate(payload, target.worktreeId, deletedOpenEditorIds, openFilesAtStart)
    if (deletedOpenEditorIds.length > 0) {
      if (hasPairedCreate) {
        // Why: single-payload delete+create is already correct — the rename
        // label is visible in one render tick, so no debounce is needed.
        const setExternalMutation = useAppStore.getState().setExternalMutation
        for (const fileId of deletedOpenEditorIds) {
          setExternalMutation(fileId, 'renamed')
        }
      } else {
        // Why: defer the 'deleted' tombstone so a follow-up same-path create
        // in the next payload can cancel it. Build a fileId → path map so we
        // can key the timer by the deleted file's absolute path.
        const deletePathByFileId = buildDeletePathByFileId(
          payload,
          target.worktreeId,
          deletedOpenEditorIds,
          openFilesAtStart
        )
        for (const fileId of deletedOpenEditorIds) {
          const absolutePath = deletePathByFileId.get(fileId)
          if (!absolutePath) {
            continue
          }
          const key = pendingKey(target.worktreeId, absolutePath)
          const existing = pendingDeletes.get(key)
          if (existing) {
            clearTimeout(existing.timer)
            pendingDeletes.delete(key)
          }
          const timer = setTimeout(() => {
            pendingDeletes.delete(key)
            // Why: the debounce widens the window between scheduling the
            // tombstone and applying it; the tab may have been closed or
            // switched out of edit mode in between. Re-check both before
            // writing so we don't resurrect state for a dropped fileId or
            // tombstone a non-edit tab (mirrors the scheduling-time filter
            // in `collectDeletedOpenEditorIds`).
            const state = useAppStore.getState()
            const stillEditing = state.openFiles.some((f) => f.id === fileId && f.mode === 'edit')
            if (stillEditing) {
              state.setExternalMutation(fileId, 'deleted')
            }
          }, EXTERNAL_MUTATION_DEBOUNCE_MS)
          pendingDeletes.set(key, { fileId, timer })
        }
      }
    }

    // Why: if a previously-deleted file reappears at the same path (e.g.
    // the user ran `git checkout`), clear the tombstone so the tab returns
    // to its normal state and any non-dirty content gets reloaded below.
    // `createOrUpdatePaths` was collected above.
    if (createOrUpdatePaths.size > 0) {
      const state = useAppStore.getState()
      for (const file of state.openFiles) {
        if (
          file.worktreeId === target.worktreeId &&
          file.mode === 'edit' &&
          file.externalMutation &&
          createOrUpdatePaths.has(normalizeAbsolutePath(file.filePath))
        ) {
          state.setExternalMutation(file.id, null)
        }
      }
    }

    const changedFiles = new Set<string>()
    for (const evt of payload.events) {
      if (evt.kind === 'overflow') {
        // Why: overflow payloads omit per-path create/update info, so any
        // stale tombstone must be cleared conservatively before we decide
        // which clean tabs to reload. Otherwise a file that reappeared on
        // disk during the overrun stays struck through until some later
        // path-specific event happens to clear it.
        for (const notification of getOverflowExternalReloadTargets(target)) {
          scheduleDebouncedExternalReload(notification)
        }
        // Why: `break` (not `return`) — the remaining code early-returns
        // when changedFiles is empty, so breaking out is semantically
        // equivalent and more robust to future code added after the loop.
        break
      }

      if (evt.kind === 'update' && evt.isDirectory === true) {
        continue
      }

      if (evt.kind === 'delete') {
        // Why: delete events are already handled above by marking the tab
        // as tombstoned. Feeding them into the reload pipeline would fire
        // `readFile` against the ENOENT path and replace the in-memory
        // content with "Error loading file..." — losing the user's view.
        continue
      }

      const relativePath = getExternalFileChangeRelativePath(
        target.worktreePath,
        normalizeAbsolutePath(evt.absolutePath),
        evt.isDirectory
      )
      if (relativePath) {
        changedFiles.add(relativePath)
      }
    }

    if (changedFiles.size === 0) {
      return
    }

    // Why: skip notifying for any tab with unsaved edits so external writes
    // don't silently destroy the user's work. Mirrors the dirty guard in
    // `useFileExplorerHandlers`. Read `openFiles` once per payload to avoid
    // N store reads for large batched events.
    const openFilesSnapshot = useAppStore.getState().openFiles
    for (const relativePath of changedFiles) {
      const notification = {
        worktreeId: target.worktreeId,
        worktreePath: target.worktreePath,
        relativePath
      }
      const matching = getOpenFilesForExternalFileChange(openFilesSnapshot, notification)
      if (matching.length === 0) {
        continue
      }
      if (matching.some((f) => f.isDirty)) {
        continue
      }
      scheduleDebouncedExternalReload(notification)
    }
  }

  const dispose = (): void => {
    // Why: clear in-flight debounced tombstone timers so they don't fire
    // after disposal and touch a no-longer-relevant store.
    for (const pending of pendingDeletes.values()) {
      clearTimeout(pending.timer)
    }
    pendingDeletes.clear()
  }

  return { handleFsChanged, dispose }
}

export function getOverflowExternalReloadTargets(
  target: Pick<WatchedTarget, 'worktreeId' | 'worktreePath'>
): ExternalWatchNotification[] {
  const state = useAppStore.getState()
  const notifications: ExternalWatchNotification[] = []

  for (const file of state.openFiles) {
    if (file.worktreeId !== target.worktreeId || file.mode !== 'edit' || file.isDirty) {
      continue
    }
    if (file.externalMutation) {
      // Why: overflow gives no per-path resurrection signal, so fall back to
      // "assume it may exist again" and clear the tombstone before reloading.
      // If the file is still gone, EditorPanel will preserve the current in-
      // memory view by showing the read failure instead of leaving a permanent
      // stale "deleted" badge with no path to recovery.
      state.setExternalMutation(file.id, null)
    }
    notifications.push({
      worktreeId: target.worktreeId,
      worktreePath: target.worktreePath,
      relativePath: file.relativePath
    })
  }

  return notifications
}

function buildDeletePathByFileId(
  payload: FsChangedPayload,
  worktreeId: string,
  deletedOpenEditorIds: string[],
  openFiles: OpenFile[]
): Map<string, string> {
  const deletePaths = new Set<string>()
  for (const evt of payload.events) {
    if (evt.kind === 'delete') {
      deletePaths.add(normalizeAbsolutePath(evt.absolutePath))
    }
  }
  const result = new Map<string, string>()
  if (deletePaths.size === 0) {
    return result
  }
  const deletedIdSet = new Set(deletedOpenEditorIds)
  for (const file of openFiles) {
    if (!deletedIdSet.has(file.id) || file.worktreeId !== worktreeId) {
      continue
    }
    const normalized = normalizeAbsolutePath(file.filePath)
    if (deletePaths.has(normalized)) {
      result.set(file.id, normalized)
    }
  }
  return result
}

function collectDeletedOpenEditorIds(
  payload: FsChangedPayload,
  worktreeId: string,
  openFiles: OpenFile[]
): string[] {
  const deletePaths = new Set<string>()
  for (const evt of payload.events) {
    if (evt.kind === 'delete') {
      deletePaths.add(normalizeAbsolutePath(evt.absolutePath))
    }
  }
  if (deletePaths.size === 0) {
    return []
  }
  const result: string[] = []
  for (const file of openFiles) {
    if (file.worktreeId !== worktreeId || file.mode !== 'edit') {
      continue
    }
    if (deletePaths.has(normalizeAbsolutePath(file.filePath))) {
      result.push(file.id)
    }
  }
  return result
}

/**
 * Returns true if the batched payload contains at least one file-create event
 * whose basename matches a deleted open editor file.
 *
 * Why: a batched fs payload may include unrelated create+delete events. A
 * blanket `events.some(kind === 'create')` would mislabel those as renames.
 * Basename correlation catches the common `git mv` / `mv` case where the
 * filename survives the move. We intentionally do NOT correlate by parent
 * directory because editor save-as-temp patterns (`rm foo.md && touch
 * foo.md.new`) routinely put unrelated creates in the same dir as a delete,
 * which would produce false rename labels. When correlation fails the caller
 * falls back to 'deleted', which is the least misleading default.
 */
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
    if (file.worktreeId !== worktreeId || file.mode !== 'edit') {
      continue
    }
    if (!deletedIdSet.has(file.id)) {
      continue
    }
    deletedBasenames.add(basename(normalizeAbsolutePath(file.filePath)))
  }
  if (deletedBasenames.size === 0) {
    return false
  }
  for (const evt of payload.events) {
    if (evt.kind !== 'create' || evt.isDirectory === true) {
      continue
    }
    if (deletedBasenames.has(basename(normalizeAbsolutePath(evt.absolutePath)))) {
      return true
    }
  }
  return false
}
