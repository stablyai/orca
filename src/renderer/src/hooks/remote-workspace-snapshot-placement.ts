import type { StoreApi } from 'zustand'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { AppState } from '../store/types'
import { resolveDirectSshTargetScope } from '../lib/direct-ssh-target-scope'
import { uniqueWorktreeIdByPath } from './remote-workspace-session-merge'

const SNAPSHOT_WORKTREE_PLACEMENT_TIMEOUT_MS = 10_000

export type RemoteWorkspaceSnapshotPlacementStore = Pick<StoreApi<AppState>, 'getState'> &
  Partial<Pick<StoreApi<AppState>, 'subscribe'>>

export function resolveDirectSshSnapshotWorktreeIds(
  state: AppState,
  authority: DirectSshAuthority
): Set<string> {
  const expectedHostId = toSshExecutionHostId(authority.targetId)
  const worktreeIds = new Set(
    resolveDirectSshTargetScope({
      targetId: authority.targetId,
      catalogRevision: 0,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo,
      detectedWorktreesByRepo: state.detectedWorktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
    }).gitWorktreeIds
  )
  // A host-qualified worktree can become placeable before duplicate repo rows reconcile.
  for (const worktree of [
    ...Object.values(state.worktreesByRepo).flat(),
    ...Object.values(state.detectedWorktreesByRepo).flatMap((result) => result.worktrees)
  ]) {
    if (worktree.hostId === expectedHostId) {
      worktreeIds.add(worktree.id)
    }
  }
  return worktreeIds
}

/** Only the rows the snapshot is allowed to replace, with no host-qualified widening. */
export function resolveExactDirectSshTargetWorktreeIds(
  state: AppState,
  authority: DirectSshAuthority
): Set<string> {
  return resolveDirectSshTargetScope({
    targetId: authority.targetId,
    catalogRevision: 0,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  }).gitWorktreeIds
}

function snapshotPathsArePlaceable(
  state: AppState,
  authority: DirectSshAuthority,
  worktreePaths: readonly string[]
): boolean {
  const resolveWorktreeId = uniqueWorktreeIdByPath(
    resolveDirectSshSnapshotWorktreeIds(state, authority)
  )
  return worktreePaths.every((worktreePath) => resolveWorktreeId(worktreePath) !== null)
}

type SnapshotPlacementCatalog = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
>

function captureSnapshotPlacementCatalog(state: AppState): SnapshotPlacementCatalog {
  return {
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  }
}

function snapshotPlacementCatalogChanged(
  previous: SnapshotPlacementCatalog,
  current: SnapshotPlacementCatalog
): boolean {
  return (Object.keys(previous) as (keyof SnapshotPlacementCatalog)[]).some(
    (key) => previous[key] !== current[key]
  )
}

export async function waitForSnapshotWorktreePlacement(
  store: RemoteWorkspaceSnapshotPlacementStore,
  authority: DirectSshAuthority,
  worktreePaths: readonly string[],
  isCurrent: () => boolean,
  signal?: AbortSignal,
  timeoutMs: number = SNAPSHOT_WORKTREE_PLACEMENT_TIMEOUT_MS
): Promise<boolean> {
  if (signal?.aborted || !isCurrent()) {
    return false
  }
  if (
    worktreePaths.length === 0 ||
    snapshotPathsArePlaceable(store.getState(), authority, worktreePaths)
  ) {
    return true
  }
  if (!store.subscribe) {
    return false
  }
  const { promise, resolve } = Promise.withResolvers<boolean>()
  let observedCatalog = captureSnapshotPlacementCatalog(store.getState())
  let unsubscribe = (): void => {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let settled = false
  const finish = (placed: boolean): void => {
    if (settled) {
      return
    }
    settled = true
    if (timer !== null) {
      clearTimeout(timer)
    }
    signal?.removeEventListener('abort', onAbort)
    unsubscribe()
    resolve(placed)
  }
  const onAbort = (): void => finish(false)
  timer = setTimeout(() => finish(false), timeoutMs)
  signal?.addEventListener('abort', onAbort, { once: true })
  const subscribedUnsubscribe = store.subscribe((state) => {
    if (!isCurrent()) {
      finish(false)
      return
    }
    const nextCatalog = captureSnapshotPlacementCatalog(state)
    if (!snapshotPlacementCatalogChanged(observedCatalog, nextCatalog)) {
      return
    }
    observedCatalog = nextCatalog
    if (snapshotPathsArePlaceable(state, authority, worktreePaths)) {
      finish(true)
    }
  })
  unsubscribe = subscribedUnsubscribe
  if (settled) {
    subscribedUnsubscribe()
  }
  if (signal?.aborted || !isCurrent()) {
    finish(false)
  }
  if (snapshotPathsArePlaceable(store.getState(), authority, worktreePaths)) {
    finish(true)
  }
  return promise
}
