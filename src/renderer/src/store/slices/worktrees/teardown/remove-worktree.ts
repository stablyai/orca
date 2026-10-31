import { recordWorktreeRemovalFailure } from './worktree-removal-failure'
import {
  captureWorkspaceRemovalScope,
  assertWorkspaceRemovalScopeCurrent
} from './workspace-removal-scope'
import {
  closeWorkspaceRemovalNativeSources,
  tearDownWorkspaceRemovalResources
} from './workspace-removal-resources'
import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { RemoveWorktreeResult } from '../../../../../../shared/worktree/create-types'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { runtimeTargetForOwnerEnvironment } from '../../../../runtime/runtime-client-target'
import { forgetHugeRepoWarningDismissalsForWorktrees } from '@/lib/source-control-huge-repo-warning-dismissals'
import { forgetWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import {
  resolveWorktreeOperationRouteResult,
  resolveWorktreeOperationRouteResultForHost
} from '@/lib/worktree-operation-route'
import {
  beginHostQualifiedRemoval,
  completeSameIdHostScopedRemoval,
  findWorktreeOnConfirmedHost,
  prepareHostScopedRemovalCompletion,
  refuseUnprovableRemoteHostRouting
} from './host-qualified-worktree-removal'
import { resolveSameIdSurvivingHostId } from './host-qualified-worktree-row-removal'
import { preservedBranchCleanupKey } from '../../../../../../shared/preserved-branch-cleanup'
import { getWorktreeDeleteStateKey } from './worktree-delete-state'
import { pruneHostedReviewLinkMutationGenerations } from '../metadata/hosted-review-link-mutation'
import { rememberAuthoritativelyRemovedWorktrees } from '../listing/authoritative-worktree-removal-memory'
import { preservedBranchRuntimeTargetByCleanupKey } from './preserved-branch-cleanup-target'
import {
  isRuntimeRepoNotFoundError,
  isRuntimeSelectorNotFoundError
} from '../listing/runtime-worktree-rpc-errors'
import { recordRemovedWorktreeSnapshotPrune } from './removed-worktree-snapshot-prune'
import { clearSessionCommitDraftForWorktree } from '@/lib/source-control-commit-draft-session'
import { dispatchWorktreeRemoval } from './dispatch-worktree-removal'
import { tearDownRemovedWorktreeRendererState } from './removed-worktree-renderer-teardown'
import { captureWorktreeStateBeforeRemoval } from './worktree-state-before-removal'
import { resolveWorktreeRemovalPreference } from './worktree-removal-preference'
import { completePreservedBranchCleanup } from './complete-preserved-branch-cleanup'

export function createRemoveWorktree(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['removeWorktree'] {
  return async (removalTarget, force, options) => {
    const worktreeId = removalTarget.id
    const policy = resolveWorktreeRemovalPreference(get().settings, force, options)
    // Enforce confirmed-host routing at this shared delete boundary so sidebar and cleanup cannot diverge onto same-ID twins (STA-4343).
    const requiredExecutionHostId = removalTarget.executionHostId
    const start = beginHostQualifiedRemoval(
      get,
      worktreeId,
      requiredExecutionHostId,
      policy.forgetLocalOnly,
      options?.ignoreWorkspaceCleanupScanSurvivors === true
    )
    if (!start.ok) {
      return { ok: false, error: start.error }
    }
    const {
      removalRoute,
      hostId,
      removalGenerationGuard,
      sameIdSurvivingHostId: catalogSameIdSurvivingHostId
    } = start
    const sameIdSurvivingHostId =
      catalogSameIdSurvivingHostId ?? options?.sameIdSurvivingHostId ?? null
    const scope = captureWorkspaceRemovalScope(
      get(),
      { id: worktreeId, hostId: hostId ?? 'local' },
      removalRoute
    )
    const beforeRemoval = captureWorktreeStateBeforeRemoval(get(), worktreeId, hostId)
    const deleteStateKey = getWorktreeDeleteStateKey(get(), worktreeId, requiredExecutionHostId)
    set((s) => ({
      deleteStateByWorktreeId: {
        ...s.deleteStateByWorktreeId,
        [deleteStateKey]: {
          isDeleting: true,
          phase: 'deleting',
          ...(requiredExecutionHostId ? { executionHostId: requiredExecutionHostId } : {}),
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
      }
    }))

    try {
      // forget-local touches no remote/archive hooks; read current trust so concurrent same-repo deletes share one approval.
      const skipArchive = policy.forgetLocalOnly
        ? true
        : (await ensureHooksConfirmed(
            get,
            getRepoIdFromWorktreeId(worktreeId),
            'archive',
            hostId,
            removalRoute?.runtimeEnvironmentId
          )) === 'skip'

      const worktreeBeforeRemoval = findWorktreeOnConfirmedHost(
        get,
        worktreeId,
        requiredExecutionHostId
      )
      if (!policy.forgetLocalOnly) {
        removalGenerationGuard?.assertCurrent()
      }
      // Why: forget-local clears Orca's records via local IPC regardless of host — the remote is gone or unreachable.
      const target = runtimeTargetForOwnerEnvironment(removalRoute?.runtimeEnvironmentId ?? null)
      const unprovableRemoteRouting = policy.forgetLocalOnly
        ? null
        : refuseUnprovableRemoteHostRouting(get, worktreeId, target.kind)
      if (unprovableRemoteRouting) {
        throw new Error(unprovableRemoteRouting)
      }
      assertWorkspaceRemovalScopeCurrent(get(), scope)
      if (!policy.forgetLocalOnly) {
        options?.assertBeforeDispatch?.()
        await closeWorkspaceRemovalNativeSources(
          get,
          scope,
          policy.options?.allowUnverifiedPtyStop === true
        )
        assertWorkspaceRemovalScopeCurrent(get(), scope)
      }
      let removalResult: RemoveWorktreeResult
      let snapshotPruneHandledByLocalMain = policy.forgetLocalOnly || target.kind === 'local'
      try {
        removalResult = await dispatchWorktreeRemoval({
          worktreeId,
          hostId,
          force: policy.force,
          skipArchive,
          get,
          target,
          options: policy.options,
          assertCurrent: () => {
            removalGenerationGuard?.assertCurrent()
            assertWorkspaceRemovalScopeCurrent(get(), scope)
          }
        })
      } catch (error) {
        if (
          !policy.forgetLocalOnly &&
          target.kind !== 'local' &&
          (isRuntimeRepoNotFoundError(error) || isRuntimeSelectorNotFoundError(error))
        ) {
          // Missing means stale mirror; ambiguous or changed ownership must fail closed.
          const currentResolution = requiredExecutionHostId
            ? resolveWorktreeOperationRouteResultForHost(get(), worktreeId, requiredExecutionHostId)
            : resolveWorktreeOperationRouteResult(get(), worktreeId)
          if (currentResolution.kind === 'ambiguous') {
            throw error
          }
          if (currentResolution.kind === 'resolved') {
            removalGenerationGuard?.assertCurrent()
          }
          try {
            removalResult = await window.api.worktrees.forgetLocal({
              worktreeId,
              hostId,
              ...(options?.snapshotPruneBatchId
                ? { snapshotPruneBatchId: options.snapshotPruneBatchId }
                : {})
            })
            snapshotPruneHandledByLocalMain = true
          } catch (fallbackError) {
            // Preserve the remote verdict as fallback failure context.
            throw new Error(
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
              { cause: error }
            )
          }
        } else {
          throw error
        }
      }

      assertWorkspaceRemovalScopeCurrent(get(), scope)
      if (!snapshotPruneHandledByLocalMain) {
        await recordRemovedWorktreeSnapshotPrune({
          worktreeId,
          hostId,
          snapshotPruneBatchId: options?.snapshotPruneBatchId
        })
      }

      assertWorkspaceRemovalScopeCurrent(get(), scope)
      await tearDownWorkspaceRemovalResources(set, get, scope, options?.confirmedDiscards)
      assertWorkspaceRemovalScopeCurrent(get(), scope)
      // Same-ID survivor keeps shared surfaces; remove only confirmed host row, but still clean its unshared VM (completeSameIdHostScopedRemoval).
      if (requiredExecutionHostId) {
        const currentSameIdSurvivingHostId = resolveSameIdSurvivingHostId(
          get(),
          worktreeId,
          requiredExecutionHostId,
          options?.ignoreWorkspaceCleanupScanSurvivors === true
        )
        const confirmedSurvivingHostId = currentSameIdSurvivingHostId ?? sameIdSurvivingHostId
        if (confirmedSurvivingHostId) {
          const sameIdStillSurvives = prepareHostScopedRemovalCompletion(
            set,
            worktreeId,
            requiredExecutionHostId,
            confirmedSurvivingHostId,
            options?.ignoreWorkspaceCleanupScanSurvivors === true
          )
          if (sameIdStillSurvives) {
            return completeSameIdHostScopedRemoval({
              set,
              get,
              worktreeId,
              requiredExecutionHostId,
              removalResult,
              removalRoute,
              target,
              worktreeBeforeRemoval,
              suppressPreservedBranchToast: options?.suppressPreservedBranchToast === true,
              rowAlreadyDropped: true
            })
          }
        }
      }

      // Why: invalidate stale probes once deletion is authoritative, so an old toast can't mutate a same-path replacement.
      forgetHugeRepoWarningDismissalsForWorktrees([worktreeId])
      forgetWorktreeSleepIntent(worktreeId)
      // Record unreachable forget-local removal to fence in-flight metadata reads; disconnected polls cannot correct resurrection.
      if (hostId && parseExecutionHostId(hostId)?.kind === 'ssh') {
        rememberAuthoritativelyRemovedWorktrees(hostId, [worktreeId])
      }

      const worktreeDisplayName = worktreeBeforeRemoval?.displayName?.trim()
      if (worktreeDisplayName && hostId) {
        try {
          await window.api.automations?.snapshotWorkspaceName?.({
            workspaceId: worktreeId,
            hostId,
            displayName: worktreeDisplayName
          })
        } catch (error) {
          // Why: snapshotting automation labels is best-effort; a stale preload/test harness must not block removal.
          console.warn('Failed to snapshot automation workspace name:', error)
        }
      }

      await tearDownRemovedWorktreeRendererState({
        set,
        get,
        worktreeId,
        hostId,
        requiredExecutionHostId,
        beforeRemoval,
        scope,
        catalogVersion: removalResult?.catalogVersion,
        confirmedDiscards: options?.confirmedDiscards
      })
      // Why: Source Control may be unmounted during deletion, so it can't be the only stale-draft cleanup path.
      clearSessionCommitDraftForWorktree(worktreeId)
      const preservedBranch = removalResult?.preservedBranch
      const cleanup = preservedBranch
        ? {
            worktreeId,
            branchName: preservedBranch.branchName,
            expectedHead: preservedBranch.head,
            ...(hostId ? { hostId } : {}),
            ...(removalRoute?.runtimeEnvironmentId
              ? { runtimeEnvironmentId: removalRoute.runtimeEnvironmentId }
              : {})
          }
        : null
      if (preservedBranch) {
        preservedBranchRuntimeTargetByCleanupKey.set(preservedBranchCleanupKey(cleanup!), {
          cleanup: cleanup!,
          target
        })
      }
      const branchCleanupOptions = {
        ...(hostId ? { hostId } : {}),
        ...(removalRoute?.runtimeEnvironmentId
          ? { runtimeEnvironmentId: removalRoute.runtimeEnvironmentId }
          : {})
      }
      const autoDeletedBranch = await completePreservedBranchCleanup({
        get,
        worktreeId,
        removalResult,
        worktreeBeforeRemoval,
        branchCleanupOptions,
        suppressToast: options?.suppressPreservedBranchToast === true
      })
      pruneHostedReviewLinkMutationGenerations([worktreeId])
      return preservedBranch && cleanup && !autoDeletedBranch
        ? {
            ok: true as const,
            preservedBranch: {
              ...preservedBranch,
              ...(cleanup.hostId ? { hostId: cleanup.hostId } : {}),
              ...(cleanup.runtimeEnvironmentId
                ? { runtimeEnvironmentId: cleanup.runtimeEnvironmentId }
                : {})
            }
          }
        : { ok: true as const }
    } catch (err) {
      return recordWorktreeRemovalFailure(set, deleteStateKey, requiredExecutionHostId, policy, err)
    }
  }
}
