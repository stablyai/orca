/** Pin every removal step to confirmed host; same repoId::path on another machine may hold different uncommitted work (STA-4343). */
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { RemoveWorktreeResult } from '../../../../../../shared/worktree/create-types'
import type { WorktreeSlice } from '../../worktree-helpers'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  getWorktreeOperationOwnerHostIds,
  resolveWorktreeOperationRoute,
  resolveWorktreeOperationRouteForHost,
  type WorktreeOperationRoute
} from '@/lib/worktree-operation-route'
import { captureWorktreeOperationGenerationGuard } from '@/lib/worktree-operation-generation'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { appliedWorktreeCatalogVersionPatch } from '../listing/worktree-catalog-version-state'
import { WORKTREE_REMOVAL_HOST_CHANGED_ERROR } from '../listing/worktree-slice-constants'
import { translate } from '@/i18n/i18n'
import { cleanupEphemeralVmRuntimesForDeleted } from '@/lib/ephemeral-vm-runtime-cleanup'
import { purgeOrphanedRuntimeSshProjects } from './orphaned-runtime-ssh-project-purge'
import { completePreservedBranchCleanup } from './complete-preserved-branch-cleanup'

import { preservedBranchCleanupKey } from '../../../../../../shared/preserved-branch-cleanup'
import { preservedBranchRuntimeTargetByCleanupKey } from './preserved-branch-cleanup-target'
import { worktreeHostMatchOptions, worktreeMatchesHost } from '../listing/worktree-host-ownership'
import {
  dropConfirmedHostRow,
  prepareHostScopedRemovalCompletion,
  preservesSameIdRendererState,
  resolveSameIdSurvivingHostId
} from './host-qualified-worktree-row-removal'
import { ambiguousWorkspaceOwnerMessage } from '@/lib/duplicate-paired-servers'

export { prepareHostScopedRemovalCompletion, preservesSameIdRendererState }

type PreservedBranchWorktree = Pick<Worktree, 'displayName' | 'isMainWorktree'> | undefined
type RemoveWorktreeSliceResult = Awaited<ReturnType<WorktreeSlice['removeWorktree']>>

/** Resolve confirmed host when given, otherwise use focus-free owner routing. */
function resolveHostQualifiedRemovalRoute(
  get: WorktreeSliceGet,
  worktreeId: string,
  requiredExecutionHostId: ExecutionHostId | null
): WorktreeOperationRoute | null {
  return requiredExecutionHostId
    ? resolveWorktreeOperationRouteForHost(get(), worktreeId, requiredExecutionHostId)
    : resolveWorktreeOperationRoute(get(), worktreeId)
}

export type HostQualifiedRemovalStart =
  | { ok: false; error: string }
  | {
      ok: true
      removalRoute: WorktreeOperationRoute | null
      hostId: ExecutionHostId | undefined
      removalGenerationGuard: ReturnType<typeof captureWorktreeOperationGenerationGuard> | null
      sameIdSurvivesOnAnotherHost: boolean
      sameIdSurvivingHostId: ExecutionHostId | null
    }

/**
 * Resolve the route a removal may run on. A caller that confirmed one host's
 * row fails closed unless the route still lands on exactly that host.
 */
export function beginHostQualifiedRemoval(
  get: WorktreeSliceGet,
  worktreeId: string,
  requiredExecutionHostId: ExecutionHostId | null,
  forgetLocalOnly: boolean,
  ignoreWorkspaceCleanupScanSurvivors = false
): HostQualifiedRemovalStart {
  const resolveRemovalRoute = (): WorktreeOperationRoute | null =>
    resolveHostQualifiedRemovalRoute(get, worktreeId, requiredExecutionHostId)
  const removalRoute = resolveRemovalRoute()
  if (!removalRoute && (!forgetLocalOnly || !requiredExecutionHostId)) {
    // Early refusal bypasses removal’s catch; clear optimistic deleting state or its spinner outlives the toast.
    get().clearWorktreeDeleteState(worktreeId)
    return { ok: false, error: ambiguousWorkspaceOwnerMessage(get(), worktreeId) }
  }
  // Fail closed rather than delete on a host the caller never confirmed.
  if (
    requiredExecutionHostId &&
    removalRoute &&
    removalRoute.executionHostId !== requiredExecutionHostId
  ) {
    get().clearWorktreeDeleteState(worktreeId)
    return { ok: false, error: WORKTREE_REMOVAL_HOST_CHANGED_ERROR }
  }
  const sameIdSurvivingHostId = resolveSameIdSurvivingHostId(
    get(),
    worktreeId,
    requiredExecutionHostId,
    ignoreWorkspaceCleanupScanSurvivors
  )
  return {
    ok: true,
    removalRoute,
    hostId: removalRoute?.executionHostId ?? requiredExecutionHostId ?? undefined,
    removalGenerationGuard: removalRoute
      ? captureWorktreeOperationGenerationGuard(
          get,
          worktreeId,
          removalRoute,
          () =>
            new Error(
              requiredExecutionHostId
                ? WORKTREE_REMOVAL_HOST_CHANGED_ERROR
                : ambiguousWorkspaceOwnerMessage(get(), worktreeId)
            ),
          // Recheck with the same confirmed/focus-free resolver or stable ownership can falsely appear changed.
          resolveRemovalRoute
        )
      : null,
    sameIdSurvivesOnAnotherHost: sameIdSurvivingHostId !== null,
    sameIdSurvivingHostId
  }
}

/** Refuse remote collisions: older hosts strip hostId and may delete a different owner; local main ships with this renderer and honors it. TODO(STA-4343): gate worktree.rm host qualification like WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY. */
export function refuseUnprovableRemoteHostRouting(
  get: WorktreeSliceGet,
  worktreeId: string,
  targetKind: string
): string | null {
  if (targetKind === 'local') {
    return null
  }
  if (getWorktreeOperationOwnerHostIds(get(), worktreeId).length <= 1) {
    return null
  }
  return translate(
    'auto.store.slices.workspace.cleanup.hostCollision',
    'Error: this workspace exists on multiple hosts at the same path'
  )
}

/** The row on the confirmed host only — a same-id row elsewhere must not stand in for it. */
export function findWorktreeOnConfirmedHost(
  get: WorktreeSliceGet,
  worktreeId: string,
  requiredExecutionHostId: ExecutionHostId | null
): PreservedBranchWorktree {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return get()
    .allWorktrees()
    .find(
      (entry) =>
        entry.id === worktreeId &&
        (!requiredExecutionHostId ||
          worktreeMatchesHost(
            entry,
            requiredExecutionHostId,
            worktreeHostMatchOptions(get(), repoId, requiredExecutionHostId)
          ))
    )
}

/** Prune only confirmed host row when a twin survives, retaining its branch follow-up. Still destroy the deleted workspace’s unshared VM or billing continues; no terminal teardown here races relay disposal. */
export async function completeSameIdHostScopedRemoval(args: {
  set: WorktreeSliceSet
  get: WorktreeSliceGet
  worktreeId: string
  requiredExecutionHostId: ExecutionHostId
  removalResult: RemoveWorktreeResult | undefined
  removalRoute: WorktreeOperationRoute | null
  target: RuntimeClientTarget
  worktreeBeforeRemoval: PreservedBranchWorktree
  suppressPreservedBranchToast: boolean
  rowAlreadyDropped?: boolean
}): Promise<Awaited<RemoveWorktreeSliceResult>> {
  const {
    set,
    get,
    worktreeId,
    requiredExecutionHostId,
    removalResult,
    removalRoute,
    target,
    worktreeBeforeRemoval,
    suppressPreservedBranchToast
  } = args
  // Why first: a listing scanned before this removal must not restore the dropped host row.
  const catalogVersion = removalResult?.catalogVersion
  if (catalogVersion) {
    set((s) =>
      appliedWorktreeCatalogVersionPatch(
        s,
        getRepoIdFromWorktreeId(worktreeId),
        requiredExecutionHostId,
        catalogVersion
      )
    )
  }
  const runtimeCleanup = await cleanupEphemeralVmRuntimesForDeleted({
    hostScopedWorkspaces: [{ workspaceId: worktreeId, executionHostId: requiredExecutionHostId }]
  })
  await purgeOrphanedRuntimeSshProjects(get, runtimeCleanup.destroyedSshTargetIds)
  if (!args.rowAlreadyDropped) {
    dropConfirmedHostRow(set, worktreeId, requiredExecutionHostId)
  }
  const preservedBranch = removalResult?.preservedBranch
  if (!preservedBranch) {
    return { ok: true as const }
  }
  const runtimeEnvironment = removalRoute?.runtimeEnvironmentId
    ? { runtimeEnvironmentId: removalRoute.runtimeEnvironmentId }
    : {}
  const cleanup = {
    worktreeId,
    branchName: preservedBranch.branchName,
    expectedHead: preservedBranch.head,
    hostId: requiredExecutionHostId,
    ...runtimeEnvironment
  }
  preservedBranchRuntimeTargetByCleanupKey.set(preservedBranchCleanupKey(cleanup), {
    cleanup,
    target
  })
  const branchCleanupOptions = { hostId: requiredExecutionHostId, ...runtimeEnvironment }
  const autoDeletedBranch = await completePreservedBranchCleanup({
    get,
    worktreeId,
    removalResult,
    worktreeBeforeRemoval,
    branchCleanupOptions,
    suppressToast: suppressPreservedBranchToast
  })
  return {
    ok: true as const,
    ...(!autoDeletedBranch
      ? {
          preservedBranch: {
            ...preservedBranch,
            hostId: requiredExecutionHostId,
            ...runtimeEnvironment
          }
        }
      : {})
  }
}
