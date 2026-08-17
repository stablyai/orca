import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { RemoveWorktreeResult } from '../../../../../../shared/worktree/create-types'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { cleanupEphemeralVmRuntimesForDeleted } from '@/lib/ephemeral-vm-runtime-cleanup'
import { disposeRemovedWorktreeParkedTerminalWatchers } from '../../../../components/terminal-pane/terminal-parked-watcher-registry'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../../../runtime/runtime-worktree-selector'
import { requestVirtualizedScrollAnchorRecord } from '@/hooks/requestVirtualizedScrollAnchorRecord'
import { forgetForegroundTerminalTabs } from '@/lib/foreground-terminal-tabs'
import { forgetAgentStartupDeliveriesForTabs } from '@/lib/agent-startup-delivery-guards'
import { forgetHugeRepoWarningDismissalsForWorktrees } from '@/lib/source-control-huge-repo-warning-dismissals'
import { clearSessionCommitDraftForWorktree } from '@/lib/source-control-commit-draft-session'
import { showPreservedBranchToast } from '@/components/sidebar/preserved-branch-toast'
import {
  resolveWorktreeOperationRoute,
  resolveWorktreeOperationRouteResult,
  settingsForWorktreeOperationRoute
} from '@/lib/worktree-operation-route'
import { captureWorktreeOperationGenerationGuard } from '@/lib/worktree-operation-generation'
import {
  classifyWorktreeForceDeleteReason,
  getLockedWorktreeRemovalReason,
  isLockedWorktreeRemovalError
} from '../../../../../../shared/worktree/removal'
import { preservedBranchCleanupKey } from '../../../../../../shared/preserved-branch-cleanup'
import { WORKTREE_REMOVAL_AMBIGUOUS_ERROR } from '../listing/worktree-slice-constants'
import { detachedHeadAutoDerivedDisplayNames } from '../metadata/detached-head-display-name'
import { pruneHostedReviewLinkMutationGenerations } from '../metadata/hosted-review-link-mutation'
import { rememberAuthoritativelyRemovedWorktrees } from '../listing/authoritative-worktree-removal-memory'
import { purgeOrphanedRuntimeSshProjects } from './orphaned-runtime-ssh-project-purge'
import { preservedBranchRuntimeTargetByCleanupKey } from './preserved-branch-cleanup-target'
import {
  isRuntimeRepoNotFoundError,
  isRuntimeSelectorNotFoundError
} from '../listing/runtime-worktree-rpc-errors'
import { applyRemoveWorktreeSuccessState } from './remove-worktree-store-cleanup'

export function createRemoveWorktree(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['removeWorktree'] {
  return async (worktreeId, force, options) => {
    const forgetLocalOnly = options?.mode === 'forget-local'
    const removalRoute = resolveWorktreeOperationRoute(get(), worktreeId)
    if (!forgetLocalOnly && !removalRoute) {
      return { ok: false, error: WORKTREE_REMOVAL_AMBIGUOUS_ERROR }
    }
    const hostId = removalRoute?.executionHostId ?? undefined
    const removalGenerationGuard = removalRoute
      ? captureWorktreeOperationGenerationGuard(
          get,
          worktreeId,
          removalRoute,
          () => new Error(WORKTREE_REMOVAL_AMBIGUOUS_ERROR)
        )
      : null
    set((s) => ({
      deleteStateByWorktreeId: {
        ...s.deleteStateByWorktreeId,
        [worktreeId]: {
          isDeleting: true,
          phase: 'deleting',
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
      }
    }))

    try {
      // Why: forget-local touches no remote, so there's no archive hook to run or trust prompt needed.
      const skipArchive = forgetLocalOnly
        ? true
        : (await ensureHooksConfirmed(
            get(),
            getRepoIdFromWorktreeId(worktreeId),
            'archive',
            hostId,
            removalRoute?.runtimeEnvironmentId
          )) === 'skip'

      const worktreeBeforeRemoval = get()
        .allWorktrees()
        .find((entry) => entry.id === worktreeId)
      const terminalPtyIdsBeforeRemoval = (get().tabsByWorktree[worktreeId] ?? []).flatMap(
        (tab) => get().ptyIdsByTabId[tab.id] ?? []
      )
      if (!forgetLocalOnly) {
        removalGenerationGuard?.assertCurrent()
      }
      // Why: forget-local clears Orca's records via local IPC regardless of host — the remote is gone or unreachable.
      const target = getActiveRuntimeTarget(
        removalRoute
          ? settingsForWorktreeOperationRoute(get().settings, removalRoute)
          : get().settings
            ? { ...get().settings, activeRuntimeEnvironmentId: null }
            : { activeRuntimeEnvironmentId: null }
      )
      let removalResult: RemoveWorktreeResult
      let snapshotPruneHandledByLocalMain = forgetLocalOnly || target.kind === 'local'
      try {
        removalResult = await (forgetLocalOnly
          ? window.api.worktrees.forgetLocal({
              worktreeId,
              hostId,
              ...(options?.snapshotPruneBatchId
                ? { snapshotPruneBatchId: options.snapshotPruneBatchId }
                : {})
            })
          : target.kind === 'local'
            ? (removalGenerationGuard?.assertCurrent(),
              window.api.worktrees.remove({
                worktreeId,
                hostId,
                force,
                allowUnverifiedPtyStop: options?.allowUnverifiedPtyStop === true,
                skipArchive,
                ...(options?.snapshotPruneBatchId
                  ? { snapshotPruneBatchId: options.snapshotPruneBatchId }
                  : {})
              }))
            : (removalGenerationGuard?.assertCurrent(),
              callRuntimeRpc<RemoveWorktreeResult>(
                target,
                'worktree.rm',
                {
                  worktree: toRuntimeWorktreeSelector(worktreeId),
                  ...(hostId ? { hostId } : {}),
                  force,
                  allowUnverifiedPtyStop: options?.allowUnverifiedPtyStop === true,
                  runHooks: !skipArchive
                },
                { timeoutMs: 60_000 }
              )))
      } catch (error) {
        if (
          !forgetLocalOnly &&
          target.kind !== 'local' &&
          (isRuntimeRepoNotFoundError(error) || isRuntimeSelectorNotFoundError(error))
        ) {
          // Missing means stale mirror; ambiguous or changed ownership must fail closed.
          const currentResolution = resolveWorktreeOperationRouteResult(get(), worktreeId)
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

      if (!snapshotPruneHandledByLocalMain) {
        try {
          await window.api.workspaceCleanup?.recordRemovalSnapshotPrune?.({
            // Why: a single (unbatched) remote delete must still drop the row
            // from the local persisted snapshots or it resurrects from cache;
            // an unknown batch id degrades to an immediate one-off prune. The
            // id must stay bounded — main rejects batch ids over 128 chars,
            // so it cannot embed the unbounded worktreeId.
            batchId: options?.snapshotPruneBatchId ?? `single-removal:${crypto.randomUUID()}`,
            worktreeId,
            ...(hostId ? { executionHostId: hostId } : {})
          })
        } catch (error) {
          console.warn('Failed to record workspace cleanup snapshot prune:', error)
        }
      }

      // Why: invalidate stale probes once deletion is authoritative, so an old toast can't mutate a same-path replacement.
      forgetHugeRepoWarningDismissalsForWorktrees([worktreeId])
      // Why: forget-local is legal while the host is unreachable, so record the removal here too — otherwise an
      // in-flight metadata read that snapshotted this row re-appends it, and disconnected polls never drop it.
      if (hostId && parseExecutionHostId(hostId)?.kind === 'ssh') {
        rememberAuthoritativelyRemovedWorktrees(hostId, [worktreeId])
      }

      const worktreeDisplayName = worktreeBeforeRemoval?.displayName?.trim()
      if (worktreeDisplayName) {
        try {
          await window.api.automations?.snapshotWorkspaceName?.({
            workspaceId: worktreeId,
            displayName: worktreeDisplayName
          })
        } catch (error) {
          // Why: snapshotting automation labels is best-effort; a stale preload/test harness must not block removal.
          console.warn('Failed to snapshot automation workspace name:', error)
        }
      }

      // Why: renderer state follows the successful backend result, so blocked dirty deletes keep their terminals intact.
      // Why browsers first: unregister Chromium guests before other teardown can intercept them (avoids a browser-state race).
      await get().shutdownWorktreeBrowsers(worktreeId)
      await get().shutdownWorktreeTerminals(worktreeId, {
        shutdownReason: 'remove-worktree',
        // The backend removal above already killed the workspace's PTYs.
        backendOwnsPtyTeardown: true
      })
      // Why: dispose the SSH relay AFTER terminal teardown so a still-mounted pane can't hit a gone relay and toast "SSH not active".
      const runtimeCleanup = await cleanupEphemeralVmRuntimesForDeleted({
        workspaceIds: [worktreeId]
      })
      // Remove the orphaned project for the destroyed SSH target so it can't surface as a dead project in the composer.
      await purgeOrphanedRuntimeSshProjects(get, runtimeCleanup.destroyedSshTargetIds)
      const tabs = get().tabsByWorktree[worktreeId] ?? []
      const tabIds = new Set(tabs.map((t) => t.id))

      // Why: this path deletes tabsByWorktree wholesale (not via closeTab), so purge the module-level tab maps here too.
      detachedHeadAutoDerivedDisplayNames.delete(worktreeId)
      forgetForegroundTerminalTabs(tabIds)
      forgetAgentStartupDeliveriesForTabs(tabIds)

      // Why: snapshot the sidebar top-row anchor in the same tick we remove the row; recording at click time goes stale across the await.
      requestVirtualizedScrollAnchorRecord('[data-worktree-sidebar]')

      // Why: dispose parked terminal watchers only on explicit deletion; identity migration/remounts must keep buffered PTY state.
      disposeRemovedWorktreeParkedTerminalWatchers(worktreeId, terminalPtyIdsBeforeRemoval)
      applyRemoveWorktreeSuccessState(set, worktreeId, tabIds)
      get().removeWorkspaceSpaceWorktrees?.([worktreeId])
      // Why: PR/commit-message generation records are keyed by worktree; prune to the surviving set so they don't leak.
      const liveWorktreeKeys = new Set(
        get()
          .allWorktrees()
          .map((w) => w.id)
      )
      // Optional-chained: minimal store assemblies (some unit tests) omit the generation slices.
      get().prunePullRequestGenerationRecords?.(liveWorktreeKeys)
      get().pruneCommitMessageGenerationRecords?.(liveWorktreeKeys)
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
      if (preservedBranch && options?.suppressPreservedBranchToast !== true) {
        showPreservedBranchToast(removalResult, worktreeBeforeRemoval, (branch, expectedHead) => {
          void get().forceDeletePreservedBranch(worktreeId, branch, expectedHead, {
            ...(hostId ? { hostId } : {}),
            ...(removalRoute?.runtimeEnvironmentId
              ? { runtimeEnvironmentId: removalRoute.runtimeEnvironmentId }
              : {})
          })
        })
      }
      pruneHostedReviewLinkMutationGenerations([worktreeId])
      return preservedBranch && cleanup
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
      // Why: git refusing a non-force delete for dirty/untracked files is a handled user decision, not an app error.
      console.warn('Failed to remove worktree:', err)
      const error = err instanceof Error ? err.message : String(err)
      const forceDeleteReason = classifyWorktreeForceDeleteReason(
        error,
        force,
        options?.allowUnverifiedPtyStop === true
      )
      const locked = isLockedWorktreeRemovalError(error)
      set((s) => ({
        deleteStateByWorktreeId: {
          ...s.deleteStateByWorktreeId,
          [worktreeId]: {
            isDeleting: false,
            error,
            canForceDelete: forceDeleteReason !== null,
            forceDeleteReason,
            ...(locked ? { lockReason: getLockedWorktreeRemovalReason(error) } : {})
          }
        }
      }))
      return { ok: false as const, error }
    }
  }
}
