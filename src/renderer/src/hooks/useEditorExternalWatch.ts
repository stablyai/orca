/* eslint-disable max-lines -- Why: the editor external-watch hook co-locates
   target diffing, fs:changed dispatch, tombstone coalescing, and rename
   correlation so the end-to-end event-to-store mutation contract stays
   readable in one file. */
import { useEffect, useRef } from 'react'
import { useAppStore, type AppState } from '@/store'
import { basename, joinPath } from '@/lib/path'
import { getExternalFileChangeRelativePath } from '@/components/right-sidebar/useFileExplorerWatch'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import {
  getOpenFilesForExternalFileChange,
  isExternalReloadableEditorTab,
  notifyEditorExternalFileChange
} from '@/components/editor/editor-autosave'
import {
  clearSelfWrite,
  getRecentSelfWrite,
  type RecentSelfWrite
} from '@/components/editor/editor-self-write-registry'
import type { FsChangedPayload } from '../../../shared/types'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { OpenFile } from '@/store/slices/editor'
import { readRuntimeFileContent, subscribeRuntimeFileChanges } from '@/runtime/runtime-file-client'

// Why: atomic-write patterns (Claude Code's Edit tool, editors like vim,
// VSCode) land as a short burst of `update` events — or `delete + create` on
// renamers — within a few milliseconds for the same path. Dispatching an
// `ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT` per raw event fan-outs into N full
// `setContent` + `normalizeSoftBreaks` doc rebuilds per mounted EditorPanel,
// which under split-pane + large markdown is enough to wedge the renderer
// and black out the window (issue #826). Coalescing per (worktreeId + path)
// on a short debounce collapses that burst into one reload notification.
const EXTERNAL_RELOAD_DEBOUNCE_MS = 75
const pendingExternalReloadTimers = new Map<string, ReturnType<typeof setTimeout>>()

function warnExternalWatchFailure(target: WatchedTarget, err: unknown): void {
  console.warn('[filesystem-watch] failed to watch worktree', {
    worktreeId: target.worktreeId,
    worktreePath: target.worktreePath,
    connectionId: target.connectionId,
    error: err instanceof Error ? err.message : String(err)
  })
}

function scheduleDebouncedExternalReload(notification: {
  worktreeId: string
  worktreePath: string
  relativePath: string
  runtimeEnvironmentId: string | null
}): void {
  const key = `${notification.worktreeId}::${notification.runtimeEnvironmentId ?? 'client'}::${notification.relativePath}`
  const existing = pendingExternalReloadTimers.get(key)
  if (existing !== undefined) {
    globalThis.clearTimeout(existing)
  }
  const handle = globalThis.setTimeout(() => {
    pendingExternalReloadTimers.delete(key)
    notifyEditorExternalFileChange(notification)
  }, EXTERNAL_RELOAD_DEBOUNCE_MS)
  pendingExternalReloadTimers.set(key, handle)
}

type WatchedTarget = {
  worktreeId: string
  worktreePath: string
  connectionId: string | undefined
  runtimeEnvironmentId: string | null
}

type ExternalWatchNotification = {
  worktreeId: string
  worktreePath: string
  relativePath: string
  runtimeEnvironmentId: string | null
}

type WatchedTargetsSnapshot = {
  targets: WatchedTarget[]
  targetsKey: string
}

export type EditorExternalWatchTargetState = Pick<
  AppState,
  | 'openFiles'
  | 'worktreesByRepo'
  | 'repos'
  | 'activeWorktreeId'
  | 'settings'
  | 'rightSidebarOpen'
  | 'rightSidebarTab'
>

let cachedOpenFiles: AppState['openFiles'] | null = null
let cachedWorktreesByRepo: AppState['worktreesByRepo'] | null = null
let cachedRepos: AppState['repos'] | null = null
let cachedActiveWorktreeId: string | null = null
let cachedRuntimeEnvironmentId: string | undefined
let cachedRightSidebarOpen: boolean | null = null
let cachedRightSidebarTab: AppState['rightSidebarTab'] | null = null
let cachedWatchedTargetsSnapshot: WatchedTargetsSnapshot = { targets: [], targetsKey: '' }

export function getWatchedTargetKey(target: WatchedTarget): string {
  // Why: SSH worktrees can exist in the store before their remote filesystem
  // provider is ready. Include connectionId so a local/unknown placeholder
  // watch is replaced by the real SSH watch when the repo metadata hydrates.
  return `${target.worktreeId}::${target.worktreePath}::${target.connectionId ?? 'local'}::${target.runtimeEnvironmentId ?? 'client'}`
}

function openFileRuntimeOwner(file: Pick<OpenFile, 'runtimeEnvironmentId'>): string | null {
  return file.runtimeEnvironmentId?.trim() || null
}

export function getEditorExternalWatchTargets(
  state: EditorExternalWatchTargetState
): WatchedTargetsSnapshot {
  const runtimeEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim() || undefined
  if (
    cachedOpenFiles === state.openFiles &&
    cachedWorktreesByRepo === state.worktreesByRepo &&
    cachedRepos === state.repos &&
    cachedActiveWorktreeId === state.activeWorktreeId &&
    cachedRuntimeEnvironmentId === runtimeEnvironmentId &&
    cachedRightSidebarOpen === state.rightSidebarOpen &&
    cachedRightSidebarTab === state.rightSidebarTab
  ) {
    return cachedWatchedTargetsSnapshot
  }

  const targetOwnersByWorktreeId = new Map<string, Set<string | null>>()
  // Why: watcher ownership is scoped by both worktree and runtime owner.
  // The same path can be open locally and in a runtime-backed workspace at
  // once; reads/saves already route per tab owner, so live reloads must too.
  for (const f of state.openFiles) {
    let owners = targetOwnersByWorktreeId.get(f.worktreeId)
    if (!owners) {
      owners = new Set()
      targetOwnersByWorktreeId.set(f.worktreeId, owners)
    }
    // Why: persisted/restored local tabs may have runtimeEnvironmentId
    // undefined. New openFile calls resolve active-runtime inheritance before
    // storing the tab, so an ownerless stored tab must stay local here.
    owners.add(openFileRuntimeOwner(f))
  }
  if (state.activeWorktreeId && state.rightSidebarOpen && state.rightSidebarTab === 'explorer') {
    // Why: the right sidebar stays mounted while hidden; do not create a
    // worktree-level watcher just because the user clicked a workspace.
    // macOS can surface privacy prompts for those passive filesystem probes.
    let owners = targetOwnersByWorktreeId.get(state.activeWorktreeId)
    if (!owners) {
      owners = new Set()
      targetOwnersByWorktreeId.set(state.activeWorktreeId, owners)
    }
    owners.add(runtimeEnvironmentId ?? null)
  }

  const nextTargets: WatchedTarget[] = []
  const parts: string[] = []
  const sortedWorktreeIds = Array.from(targetOwnersByWorktreeId.keys()).sort()
  for (const id of sortedWorktreeIds) {
    const wt = findWorktreeById(state.worktreesByRepo, id)
    if (!wt) {
      continue
    }
    const repo = state.repos.find((r) => r.id === wt.repoId)
    const owners = Array.from(targetOwnersByWorktreeId.get(id) ?? []).sort((a, b) =>
      (a ?? '').localeCompare(b ?? '')
    )
    for (const owner of owners) {
      const target = {
        worktreeId: id,
        worktreePath: wt.path,
        connectionId: repo?.connectionId ?? undefined,
        runtimeEnvironmentId: owner
      }
      nextTargets.push(target)
      parts.push(getWatchedTargetKey(target))
    }
  }

  const targetsKey = parts.join('|')
  cachedOpenFiles = state.openFiles
  cachedWorktreesByRepo = state.worktreesByRepo
  cachedRepos = state.repos
  cachedActiveWorktreeId = state.activeWorktreeId
  cachedRuntimeEnvironmentId = runtimeEnvironmentId
  cachedRightSidebarOpen = state.rightSidebarOpen
  cachedRightSidebarTab = state.rightSidebarTab

  if (targetsKey === cachedWatchedTargetsSnapshot.targetsKey) {
    return cachedWatchedTargetsSnapshot
  }

  cachedWatchedTargetsSnapshot = { targets: nextTargets, targetsKey }
  return cachedWatchedTargetsSnapshot
}

// Why: macOS atomic writes (Claude Code Edit, vim :w, VSCode save) deliver a
// delete event immediately followed by a create event for the same path. When
// those two land in separate fs:changed payloads a few ms apart, the tab
// flickers struck-through for one render before the follow-up create clears
// it. Debouncing just the 'deleted' signal — keyed by absolute path — lets a
// same-path create in the next payload cancel the tombstone before it ever
// paints. Key by owner as well as path so local/runtime tabs for the same
// worktree file cannot cancel each other's tombstones. A naked delete still
// resolves to 'deleted' after the window. The in-payload rename correlation
// is unchanged.
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
  const { targets, targetsKey } = useAppStore(getEditorExternalWatchTargets)

  const targetsRef = useRef<WatchedTarget[]>([])
  const latestTargetsRef = useRef<WatchedTarget[]>(targets)
  latestTargetsRef.current = targets
  const remoteWatchUnsubsRef = useRef(new Map<string, () => void>())
  const fsChangedHandlerRef = useRef<
    ((payload: FsChangedPayload, runtimeEnvironmentId?: string | null) => void) | null
  >(null)

  // Why: diff previous vs next targets so unchanged worktrees keep their
  // existing subscription. Tearing down every subscription on each targetsKey
  // change (e.g. opening/closing a tab in an already-watched worktree) causes
  // a watcher churn that can drop events emitted during the gap.
  useEffect(() => {
    const nextTargets = latestTargetsRef.current
    const prev = targetsRef.current
    const prevKeys = new Set(prev.map(getWatchedTargetKey))
    const nextKeys = new Set(nextTargets.map(getWatchedTargetKey))
    const removed = prev.filter((t) => !nextKeys.has(getWatchedTargetKey(t)))
    const added = nextTargets.filter((t) => !prevKeys.has(getWatchedTargetKey(t)))

    for (const target of removed) {
      const key = getWatchedTargetKey(target)
      const remoteUnsubscribe = remoteWatchUnsubsRef.current.get(key)
      if (remoteUnsubscribe) {
        remoteUnsubscribe()
        remoteWatchUnsubsRef.current.delete(key)
      } else {
        void window.api.fs.unwatchWorktree({
          worktreePath: target.worktreePath,
          connectionId: target.connectionId
        })
      }
    }
    for (const target of added) {
      if (target.runtimeEnvironmentId) {
        const key = getWatchedTargetKey(target)
        let cancelled = false
        const pendingUnsubscribe = (): void => {
          cancelled = true
        }
        remoteWatchUnsubsRef.current.set(key, pendingUnsubscribe)
        void subscribeRuntimeFileChanges(
          {
            settings: { activeRuntimeEnvironmentId: target.runtimeEnvironmentId },
            worktreeId: target.worktreeId,
            worktreePath: target.worktreePath,
            connectionId: target.connectionId
          },
          (payload) => fsChangedHandlerRef.current?.(payload, target.runtimeEnvironmentId),
          (err) => warnExternalWatchFailure(target, err)
        )
          .then((unsubscribe) => {
            if (cancelled) {
              unsubscribe()
              return
            }
            if (remoteWatchUnsubsRef.current.get(key) === pendingUnsubscribe) {
              remoteWatchUnsubsRef.current.set(key, unsubscribe)
            } else {
              unsubscribe()
            }
          })
          .catch((err) => {
            if (remoteWatchUnsubsRef.current.get(key) === pendingUnsubscribe) {
              remoteWatchUnsubsRef.current.delete(key)
            }
            warnExternalWatchFailure(target, err)
          })
        continue
      }
      void window.api.fs
        .watchWorktree({
          worktreePath: target.worktreePath,
          connectionId: target.connectionId
        })
        .catch((err) => {
          // Why: remote SSH providers can disappear while tabs still reference
          // the worktree. Watching should degrade to a diagnostic, not an
          // uncaught renderer promise that looks like the terminal froze.
          warnExternalWatchFailure(target, err)
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
    const remoteWatchUnsubs = remoteWatchUnsubsRef.current
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(
      (worktreePath, runtimeEnvironmentId) =>
        targetsRef.current.find(
          (t) =>
            normalizeRuntimePathForComparison(t.worktreePath) ===
              normalizeRuntimePathForComparison(worktreePath) &&
            t.runtimeEnvironmentId === runtimeEnvironmentId
        )
    )
    const unsubscribe = window.api.fs.onFsChanged((payload) => handleFsChanged(payload, null))
    fsChangedHandlerRef.current = handleFsChanged

    return () => {
      unsubscribe()
      dispose()
      fsChangedHandlerRef.current = null
      // Why: final unmount must tear down every outstanding subscription.
      // The differential watch effect above intentionally never unwatches on
      // cleanup, so this is the only place that clears them.
      for (const target of targetsRef.current) {
        const key = getWatchedTargetKey(target)
        const remoteUnsubscribe = remoteWatchUnsubs.get(key)
        if (remoteUnsubscribe) {
          remoteUnsubscribe()
        } else {
          void window.api.fs.unwatchWorktree({
            worktreePath: target.worktreePath,
            connectionId: target.connectionId
          })
        }
      }
      remoteWatchUnsubs.clear()
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
  findTarget: (
    worktreePath: string,
    runtimeEnvironmentId: string | null
  ) => WatchedTarget | undefined
): {
  handleFsChanged: (payload: FsChangedPayload, runtimeEnvironmentId?: string | null) => void
  dispose: () => void
} {
  // Why: coalesce 'deleted' tombstones across back-to-back payloads so a
  // same-path create arriving in the next payload (macOS atomic write)
  // cancels the tombstone before the tab flashes. Keyed by normalized
  // absolute path, scoped per-target. See EXTERNAL_MUTATION_DEBOUNCE_MS.
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

    // Why: collect create/update paths first so we can cancel any pending
    // same-path delete before scheduling a new one. This is what absorbs
    // the macOS atomic-write delete→create split across two payloads.
    const createOrUpdatePaths = new Set<string>()
    for (const evt of payload.events) {
      if (evt.isDirectory === true) {
        continue
      }
      if (evt.kind === 'create' || evt.kind === 'update') {
        createOrUpdatePaths.add(normalizeRuntimePathForComparison(evt.absolutePath))
      }
    }
    for (const createdPath of createOrUpdatePaths) {
      const key = pendingKey(target.worktreeId, target.runtimeEnvironmentId, createdPath)
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
      target.runtimeEnvironmentId,
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
          target.runtimeEnvironmentId,
          deletedOpenEditorIds,
          openFilesAtStart
        )
        for (const fileId of deletedOpenEditorIds) {
          const absolutePath = deletePathByFileId.get(fileId)
          if (!absolutePath) {
            continue
          }
          const key = pendingKey(target.worktreeId, target.runtimeEnvironmentId, absolutePath)
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
          openFileRuntimeOwner(file) === target.runtimeEnvironmentId &&
          (file.mode === 'edit' || file.mode === 'markdown-preview') &&
          file.externalMutation &&
          createOrUpdatePaths.has(normalizeRuntimePathForComparison(file.filePath))
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
        evt.absolutePath,
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
        relativePath,
        runtimeEnvironmentId: target.runtimeEnvironmentId
      }
      const matching = getOpenFilesForExternalFileChange(openFilesSnapshot, notification)
      if (matching.length === 0) {
        continue
      }
      if (matching.some((f) => f.isDirty)) {
        continue
      }
      const absolutePath = joinPath(notification.worktreePath, notification.relativePath)
      const recentSelfWrite = getRecentSelfWrite(absolutePath, target.runtimeEnvironmentId)
      if (recentSelfWrite) {
        scheduleSelfWriteAwareExternalReload(target, notification, matching[0], recentSelfWrite)
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

function scheduleSelfWriteAwareExternalReload(
  target: WatchedTarget,
  notification: ExternalWatchNotification,
  file: OpenFile,
  recentSelfWrite: RecentSelfWrite
): void {
  if (recentSelfWrite.content === null) {
    scheduleDebouncedExternalReload(notification)
    return
  }

  const runtimeEnvironmentId = file.runtimeEnvironmentId ?? target.runtimeEnvironmentId
  // Why: a recent self-write stamp only proves the path changed recently; an
  // agent can write a newer version inside the same TTL. Compare disk content
  // with the saved text so we suppress only the echo of Orca's own write.
  void readRuntimeFileContent({
    settings: runtimeEnvironmentId ? { activeRuntimeEnvironmentId: runtimeEnvironmentId } : null,
    filePath: file.filePath,
    relativePath: file.relativePath,
    worktreeId: file.worktreeId,
    connectionId: target.connectionId
  })
    .then((result) => {
      if (
        (result.isBinary || result.content !== recentSelfWrite.content) &&
        hasCleanExternalReloadTarget(notification)
      ) {
        clearSelfWrite(file.filePath, runtimeEnvironmentId)
        scheduleDebouncedExternalReload(notification)
      }
    })
    .catch(() => {
      if (hasCleanExternalReloadTarget(notification)) {
        clearSelfWrite(file.filePath, runtimeEnvironmentId)
        scheduleDebouncedExternalReload(notification)
      }
    })
}

function hasCleanExternalReloadTarget(notification: ExternalWatchNotification): boolean {
  const matching = getOpenFilesForExternalFileChange(useAppStore.getState().openFiles, notification)
  return matching.length > 0 && matching.every((file) => !file.isDirty)
}

export function getOverflowExternalReloadTargets(
  target: Pick<WatchedTarget, 'worktreeId' | 'worktreePath'> & {
    runtimeEnvironmentId?: string | null
  }
): ExternalWatchNotification[] {
  const state = useAppStore.getState()
  const notifications: ExternalWatchNotification[] = []

  for (const file of state.openFiles) {
    if (
      file.worktreeId !== target.worktreeId ||
      openFileRuntimeOwner(file) !== (target.runtimeEnvironmentId ?? null) ||
      !isExternalReloadableEditorTab(file) ||
      file.isDirty
    ) {
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
      relativePath: file.relativePath,
      runtimeEnvironmentId: target.runtimeEnvironmentId ?? null
    })
  }

  return notifications
}

function buildDeletePathByFileId(
  payload: FsChangedPayload,
  worktreeId: string,
  runtimeEnvironmentId: string | null,
  deletedOpenEditorIds: string[],
  openFiles: OpenFile[]
): Map<string, string> {
  const deletePaths = new Set<string>()
  for (const evt of payload.events) {
    if (evt.kind === 'delete') {
      deletePaths.add(normalizeRuntimePathForComparison(evt.absolutePath))
    }
  }
  const result = new Map<string, string>()
  if (deletePaths.size === 0) {
    return result
  }
  const deletedIdSet = new Set(deletedOpenEditorIds)
  for (const file of openFiles) {
    if (
      !deletedIdSet.has(file.id) ||
      file.worktreeId !== worktreeId ||
      openFileRuntimeOwner(file) !== runtimeEnvironmentId
    ) {
      continue
    }
    const normalized = normalizeRuntimePathForComparison(file.filePath)
    if (deletePaths.has(normalized)) {
      result.set(file.id, normalized)
    }
  }
  return result
}

function collectDeletedOpenEditorIds(
  payload: FsChangedPayload,
  worktreeId: string,
  runtimeEnvironmentId: string | null,
  openFiles: OpenFile[]
): string[] {
  const deletePaths = new Set<string>()
  for (const evt of payload.events) {
    if (evt.kind === 'delete') {
      deletePaths.add(normalizeRuntimePathForComparison(evt.absolutePath))
    }
  }
  if (deletePaths.size === 0) {
    return []
  }
  const result: string[] = []
  for (const file of openFiles) {
    if (
      file.worktreeId !== worktreeId ||
      openFileRuntimeOwner(file) !== runtimeEnvironmentId ||
      (file.mode !== 'edit' && file.mode !== 'markdown-preview')
    ) {
      continue
    }
    if (deletePaths.has(normalizeRuntimePathForComparison(file.filePath))) {
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
    if (
      file.worktreeId !== worktreeId ||
      (file.mode !== 'edit' && file.mode !== 'markdown-preview')
    ) {
      continue
    }
    if (!deletedIdSet.has(file.id)) {
      continue
    }
    deletedBasenames.add(basename(file.filePath))
  }
  if (deletedBasenames.size === 0) {
    return false
  }
  for (const evt of payload.events) {
    if (evt.kind !== 'create' || evt.isDirectory === true) {
      continue
    }
    if (deletedBasenames.has(basename(evt.absolutePath))) {
      return true
    }
  }
  return false
}
