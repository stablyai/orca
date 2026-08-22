import type { StoreApi } from 'zustand'
import { getRepoExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import type { HostLineageSnapshot } from '../../../shared/host-lineage-contract'
import type { HostRepoCatalogSnapshot } from '../../../shared/host-repo-catalog-contract'
import { applyManualRepoOrder } from '../../../shared/manual-repo-order'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import { isWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from '../store/types'
import { reuseEqualRecordMap } from '../store/slices/repo-identity-reconcile'
import type {
  DirectSshLineageOutcome,
  DirectSshPreparationInput,
  DirectSshPreparationReason
} from './direct-ssh-reconnect-coordinator'
import { directSshHostHydrationTelemetry } from './direct-ssh-host-hydration-telemetry'
import { directSshHostHydrationScope } from './direct-ssh-host-hydration-scope'
import { directSshAuthoritiesEqual } from './direct-ssh-reconnect-tokens'

export const DIRECT_SSH_HOST_READ_TIMEOUT_MS = 5_000

type HostReadTimer = unknown

export type DirectSshHostHydrationDeps = {
  store: Pick<StoreApi<AppState>, 'getState' | 'setState'>
  listRepos: (authority: DirectSshAuthority) => Promise<HostRepoCatalogSnapshot>
  listLineage: (authority: DirectSshAuthority) => Promise<HostLineageSnapshot>
  isCurrentAuthority: (authority: DirectSshAuthority) => boolean
  setTimer?: (callback: () => void, delayMs: number) => HostReadTimer
  clearTimer?: (timer: HostReadTimer) => void
}

export type DirectSshHostHydration = {
  capturePreparationInput: (
    authority: DirectSshAuthority,
    reason: DirectSshPreparationReason,
    snapshotRevision?: number
  ) => Promise<DirectSshPreparationInput | null>
  readHostScopedLineage: (input: DirectSshPreparationInput) => Promise<DirectSshLineageOutcome>
  isPreparationTokenCurrent: (token: {
    authority: DirectSshAuthority
    catalogRevision: number
    repoFingerprint: string
  }) => boolean
  stop: () => void
}

type BoundedResult<T> = { status: 'complete'; value: T } | { status: 'timed-out' | 'unavailable' }

function isAuthoritativeHost(
  authority: HostRepoCatalogSnapshot | HostLineageSnapshot,
  expected: DirectSshAuthority
): authority is Extract<typeof authority, { authoritative: true }> {
  if (!authority.authoritative || authority.authority.kind !== 'direct-ssh') {
    return false
  }
  return (
    authority.authority.executionHostId === toSshExecutionHostId(expected.targetId) &&
    directSshAuthoritiesEqual(authority.authority, expected)
  )
}

function mergeExactHostCatalog(state: AppState, snapshot: HostRepoCatalogSnapshot): AppState {
  if (!snapshot.authoritative || snapshot.authority.kind !== 'direct-ssh') {
    return state
  }
  const hostId = snapshot.authority.executionHostId
  // Why re-apply the overlay: re-appending the host's rows puts them at the tail, which would
  // undo the user's manual cross-host order on every connect.
  return {
    ...state,
    repos: applyManualRepoOrder(
      [...state.repos.filter((repo) => getRepoExecutionHostId(repo) !== hostId), ...snapshot.repos],
      state.manualRepoOrder
    )
  }
}

// Why: the host owns every in-scope key, so drop the stale in-scope rows, overlay the snapshot's,
// and leave out-of-scope hosts alone. Reusing equal rows keeps a cloned no-op read from republishing.
function overlayHostScopedLineage<T>(
  previous: Readonly<Record<string, T>>,
  incoming: Readonly<Record<string, T>>,
  isHostScoped: (key: string) => boolean
): Readonly<Record<string, T>> {
  const next: Record<string, T> = Object.fromEntries([
    ...Object.entries(previous).filter(([key]) => !isHostScoped(key)),
    ...Object.entries(incoming).filter(([key]) => isHostScoped(key))
  ])
  return reuseEqualRecordMap(previous, next)
}

function mergeExactHostLineage(
  state: AppState,
  snapshot: Extract<HostLineageSnapshot, { authoritative: true }>,
  authority: DirectSshAuthority,
  catalogRevision: number
): AppState {
  const scope = directSshHostHydrationScope(state, authority, catalogRevision)
  const worktreeLineageById = overlayHostScopedLineage(
    state.worktreeLineageById,
    snapshot.worktreeLineageById,
    (worktreeId) => scope.gitWorktreeIds.has(worktreeId)
  )
  const workspaceLineageByChildKey = overlayHostScopedLineage(
    state.workspaceLineageByChildKey,
    snapshot.workspaceLineageByChildKey,
    (childKey) => isWorkspaceKey(childKey) && scope.lineageWorkspaceKeys.has(childKey)
  )
  if (
    worktreeLineageById === state.worktreeLineageById &&
    workspaceLineageByChildKey === state.workspaceLineageByChildKey
  ) {
    return state
  }
  return { ...state, worktreeLineageById, workspaceLineageByChildKey }
}

export function createDirectSshHostHydration(
  deps: DirectSshHostHydrationDeps
): DirectSshHostHydration {
  const setTimer: NonNullable<DirectSshHostHydrationDeps['setTimer']> =
    deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer: NonNullable<DirectSshHostHydrationDeps['clearTimer']> =
    deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const catalogRevisionByTarget = new Map<string, number>()
  const catalogInFlight = new Map<string, Promise<'complete' | 'degraded' | 'stale'>>()
  const pendingDeadlines = new Set<{ timer: HostReadTimer; settle: () => void }>()
  let stopped = false

  const bounded = async <T>(operation: Promise<T>): Promise<BoundedResult<T>> => {
    let pendingDeadline: { timer: HostReadTimer; settle: () => void } | undefined
    const deadline = new Promise<BoundedResult<T>>((resolve) => {
      const settle = (): void => resolve({ status: 'timed-out' })
      const timer = setTimer(settle, DIRECT_SSH_HOST_READ_TIMEOUT_MS)
      pendingDeadline = { timer, settle }
      pendingDeadlines.add(pendingDeadline)
    })
    try {
      return await Promise.race([
        operation.then<BoundedResult<T>, BoundedResult<T>>(
          (value) => ({ status: 'complete', value }),
          () => ({ status: 'unavailable' })
        ),
        deadline
      ])
    } finally {
      if (pendingDeadline) {
        clearTimer(pendingDeadline.timer)
        pendingDeadlines.delete(pendingDeadline)
      }
    }
  }

  const refreshCatalog = (
    authority: DirectSshAuthority
  ): Promise<'complete' | 'degraded' | 'stale'> => {
    const key = JSON.stringify([
      authority.targetId,
      authority.providerEpoch,
      authority.connectionGeneration
    ])
    const existing = catalogInFlight.get(key)
    if (existing) {
      return existing
    }
    const operation = (async (): Promise<'complete' | 'degraded' | 'stale'> => {
      const boundedResult = await bounded(Promise.resolve().then(() => deps.listRepos(authority)))
      if (stopped || !deps.isCurrentAuthority(authority)) {
        return 'stale'
      }
      if (boundedResult.status !== 'complete') {
        return 'degraded'
      }
      const snapshot = boundedResult.value
      if (!snapshot.authoritative) {
        return snapshot.reason === 'stale' || snapshot.reason === 'rejected' ? 'stale' : 'degraded'
      }
      if (
        !isAuthoritativeHost(snapshot, authority) ||
        snapshot.repos.some(
          (repo) =>
            getRepoExecutionHostId(repo) !== toSshExecutionHostId(authority.targetId) ||
            repo.connectionId !== authority.targetId
        )
      ) {
        return 'stale'
      }
      let admitted = false
      deps.store.setState((state) => {
        if (stopped || !deps.isCurrentAuthority(authority)) {
          return state
        }
        admitted = true
        return mergeExactHostCatalog(state, snapshot)
      })
      if (!admitted) {
        return 'stale'
      }
      catalogRevisionByTarget.set(
        authority.targetId,
        (catalogRevisionByTarget.get(authority.targetId) ?? 0) + 1
      )
      return 'complete'
    })().finally(() => {
      if (catalogInFlight.get(key) === operation) {
        catalogInFlight.delete(key)
      }
    })
    catalogInFlight.set(key, operation)
    return operation
  }

  const capturePreparationInput = async (
    authority: DirectSshAuthority,
    reason: DirectSshPreparationReason,
    snapshotRevision?: number
  ): Promise<DirectSshPreparationInput | null> => {
    const catalogStartedAt = Date.now()
    const catalogOutcome = await refreshCatalog(authority)
    const catalogDurationMs = Math.max(0, Date.now() - catalogStartedAt)
    if (catalogOutcome === 'stale' || stopped || !deps.isCurrentAuthority(authority)) {
      return null
    }
    const catalogRevision = catalogRevisionByTarget.get(authority.targetId) ?? 0
    const scope = directSshHostHydrationScope(deps.store.getState(), authority, catalogRevision)
    return {
      ...authority,
      catalogRevision,
      repoRefs: scope.gitRepos,
      authorityRequirement: 'required',
      ...(snapshotRevision === undefined ? {} : { snapshotRevision }),
      reason,
      telemetry: directSshHostHydrationTelemetry(scope, catalogOutcome, catalogDurationMs)
    }
  }

  const readHostScopedLineage = async (
    input: DirectSshPreparationInput
  ): Promise<DirectSshLineageOutcome> => {
    const authority = {
      targetId: input.targetId,
      providerEpoch: input.providerEpoch,
      connectionGeneration: input.connectionGeneration
    }
    const boundedResult = await bounded(Promise.resolve().then(() => deps.listLineage(authority)))
    if (
      stopped ||
      !deps.isCurrentAuthority(authority) ||
      (catalogRevisionByTarget.get(authority.targetId) ?? 0) !== input.catalogRevision
    ) {
      return 'stale'
    }
    if (boundedResult.status !== 'complete') {
      return 'degraded'
    }
    const snapshot = boundedResult.value
    if (!snapshot.authoritative) {
      return snapshot.reason === 'stale' || snapshot.reason === 'rejected' ? 'stale' : 'degraded'
    }
    if (!isAuthoritativeHost(snapshot, authority)) {
      return 'stale'
    }
    let admitted = false
    deps.store.setState((state) => {
      if (
        stopped ||
        !deps.isCurrentAuthority(authority) ||
        (catalogRevisionByTarget.get(authority.targetId) ?? 0) !== input.catalogRevision
      ) {
        return state
      }
      admitted = true
      return mergeExactHostLineage(state, snapshot, authority, input.catalogRevision)
    })
    return admitted ? 'complete' : 'stale'
  }

  return {
    capturePreparationInput,
    readHostScopedLineage,
    isPreparationTokenCurrent: (token) => {
      if (
        stopped ||
        !deps.isCurrentAuthority(token.authority) ||
        (catalogRevisionByTarget.get(token.authority.targetId) ?? 0) !== token.catalogRevision
      ) {
        return false
      }
      const scope = directSshHostHydrationScope(
        deps.store.getState(),
        token.authority,
        token.catalogRevision
      )
      const sortedRepos = [...scope.gitRepos].sort((left, right) => {
        const leftKey = `${left.executionHostId}\0${left.repoId}`
        const rightKey = `${right.executionHostId}\0${right.repoId}`
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
      })
      return (
        JSON.stringify(sortedRepos.map((repo) => [repo.executionHostId, repo.repoId])) ===
        token.repoFingerprint
      )
    },
    stop: () => {
      stopped = true
      for (const deadline of pendingDeadlines) {
        clearTimer(deadline.timer)
        deadline.settle()
      }
      pendingDeadlines.clear()
      catalogInFlight.clear()
    }
  }
}
