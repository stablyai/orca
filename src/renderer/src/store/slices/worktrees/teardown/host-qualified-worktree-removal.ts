/**
 * STA-4343: a cleanup row is identified by `repoId::path`, which two execution
 * hosts can both publish. Once a caller confirms ONE host's row, every step of
 * the removal must stay pinned to that host — routing at the ACTIVE workspace's
 * host instead deletes another machine's uncommitted work.
 */
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { RemoveWorktreeResult } from '../../../../../../shared/worktree/create-types'
import type { WorktreeSlice } from '../../worktree-helpers'
import type { getActiveRuntimeTarget } from '../../../../runtime/runtime-rpc-client'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  getWorktreeOperationOwnerHostIds,
  resolveWorktreeOperationRoute,
  resolveWorktreeOperationRouteForHost,
  type WorktreeOperationRoute
} from '@/lib/worktree-operation-route'
import { captureWorktreeOperationGenerationGuard } from '@/lib/worktree-operation-generation'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import {
  WORKTREE_REMOVAL_AMBIGUOUS_ERROR,
  WORKTREE_REMOVAL_HOST_CHANGED_ERROR
} from '../listing/worktree-slice-constants'
import { translate } from '@/i18n/i18n'
import { cleanupEphemeralVmRuntimesForDeleted } from '@/lib/ephemeral-vm-runtime-cleanup'
import { purgeOrphanedRuntimeSshProjects } from './orphaned-runtime-ssh-project-purge'
import { showPreservedBranchToast } from '@/components/sidebar/preserved-branch-toast'

import { preservedBranchCleanupKey } from '../../../../../../shared/preserved-branch-cleanup'
import { preservedBranchRuntimeTargetByCleanupKey } from './preserved-branch-cleanup-target'
import { worktreeHostMatchOptions, worktreeMatchesHost } from '../listing/worktree-host-ownership'
import {
  dropConfirmedHostRow,
  prepareHostScopedRemovalCompletion,
  preservesSameIdRendererState,
  resolveSameIdSurvivingHostId
} from './host-qualified-worktree-row-removal'

export { prepareHostScopedRemovalCompletion, preservesSameIdRendererState }

type PreservedBranchWorktree = Parameters<typeof showPreservedBranchToast>[1]
type RemoveWorktreeSliceResult = Awaited<ReturnType<WorktreeSlice['removeWorktree']>>

/** Route at the confirmed host when there is one, else the ordinary active-host route. */
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
    // Why: callers mark rows deleting up front for immediate sidebar feedback
    // (worktree-delete-execution.ts), and a refusal returns before the try/catch that
    // would otherwise clear it. The failure toast auto-dismisses after 10s, so without
    // this the workspace sits on a "Deleting…" spinner forever with no explanation left
    // on screen.
    get().clearWorktreeDeleteState(worktreeId)
    return { ok: false, error: WORKTREE_REMOVAL_AMBIGUOUS_ERROR }
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
                : WORKTREE_REMOVAL_AMBIGUOUS_ERROR
            ),
          // Why: every mid-flight re-check must re-resolve at the CONFIRMED host,
          // or the active host's route would read as "ownership changed".
          requiredExecutionHostId ? resolveRemovalRoute : undefined
        )
      : null,
    sameIdSurvivesOnAnotherHost: sameIdSurvivingHostId !== null,
    sameIdSurvivingHostId
  }
}

/**
 * The refusal to report when a colliding id would be routed over a transport
 * whose host we cannot prove honours `hostId`, or null when it is safe.
 *
 * Local main always honours it — it ships with this renderer. A paired remote
 * server may not: hosts older than the host-qualified `worktree.rm` silently
 * `.strip()` the field and route by their own preference, which on a colliding
 * id deletes the wrong workspace. #14731 refused EVERY collision; narrowing that
 * to the one transport that can still be an older build keeps this no worse than
 * main while failing CLOSED rather than deleting on an unproven host.
 *
 * TODO(STA-4343): replace with a `worktree.rm` host-qualification capability (see
 * WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY for the established pattern) so
 * a new remote host can route the collision instead of sharing the old refusal.
 */
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

/**
 * Finish a removal whose id still exists on another host: prune just the
 * confirmed host's row and keep the preserved-branch follow-up pinned to it.
 *
 * Tears down the ephemeral VM even though the shared renderer state survives. A
 * VM is NOT shared: it belongs to the workspace just deleted. The likeliest real
 * collision is one machine reachable as both `runtime:env` and `ssh:target`, so
 * skipping it left the VM running and billing after its row was removed. Safe to
 * do here without the full path's ordering care, because this path tears down no
 * terminals — there is no still-mounted pane to race a disposed relay.
 */
export async function completeSameIdHostScopedRemoval(args: {
  set: WorktreeSliceSet
  get: WorktreeSliceGet
  worktreeId: string
  requiredExecutionHostId: ExecutionHostId
  removalResult: RemoveWorktreeResult | undefined
  removalRoute: WorktreeOperationRoute | null
  target: ReturnType<typeof getActiveRuntimeTarget>
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
  if (!suppressPreservedBranchToast) {
    showPreservedBranchToast(removalResult, worktreeBeforeRemoval, (branch, expectedHead) => {
      void get().forceDeletePreservedBranch(worktreeId, branch, expectedHead, {
        hostId: requiredExecutionHostId,
        ...runtimeEnvironment
      })
    })
  }
  return {
    ok: true as const,
    preservedBranch: { ...preservedBranch, hostId: requiredExecutionHostId, ...runtimeEnvironment }
  }
}
