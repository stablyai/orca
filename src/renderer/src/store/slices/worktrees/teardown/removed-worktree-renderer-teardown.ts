import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { WorktreeCatalogVersion } from '../../../../../../shared/worktree/catalog-version'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { appliedWorktreeCatalogVersionPatch } from '../listing/worktree-catalog-version-state'
import { cleanupEphemeralVmRuntimesForDeleted } from '@/lib/ephemeral-vm-runtime-cleanup'
import { forgetAgentStartupDeliveriesForTabs } from '@/lib/agent-startup-delivery-guards'
import { forgetForegroundTerminalTabs } from '@/lib/foreground-terminal-tabs'
import { requestVirtualizedScrollAnchorRecord } from '@/hooks/requestVirtualizedScrollAnchorRecord'
import { disposeRemovedWorktreeParkedTerminalWatchers } from '../../../../components/terminal-pane/terminal-parked-watcher-registry'
import { detachedHeadAutoDerivedDisplayNames } from '../metadata/detached-head-display-name'
import { applyRemoveWorktreeSuccessState } from './remove-worktree-store-cleanup'
import { purgeOrphanedRuntimeSshProjects } from './orphaned-runtime-ssh-project-purge'

/**
 * Renderer-side teardown after the backend removal succeeded.
 *
 * Ordering is load-bearing: browsers unregister before other teardown can
 * intercept their guests, and the SSH relay is disposed AFTER terminal teardown
 * so a still-mounted pane cannot hit a gone relay.
 */
export async function tearDownRemovedWorktreeRendererState(args: {
  set: WorktreeSliceSet
  get: WorktreeSliceGet
  worktreeId: string
  hostId: ExecutionHostId | undefined
  requiredExecutionHostId: ExecutionHostId | null
  terminalPtyIdsBeforeRemoval: readonly string[]
  /** The catalog the host's removal produced, when the host stamps it. */
  catalogVersion?: WorktreeCatalogVersion
}): Promise<void> {
  const { set, get, worktreeId, hostId, requiredExecutionHostId, terminalPtyIdsBeforeRemoval } =
    args
  // Why first: a listing scanned before this removal must not be applied after it and bring
  // the row back, so the version is on record before any await below yields.
  if (hostId && args.catalogVersion) {
    const catalogVersion = args.catalogVersion
    set((s) =>
      appliedWorktreeCatalogVersionPatch(
        s,
        getRepoIdFromWorktreeId(worktreeId),
        hostId,
        catalogVersion
      )
    )
  }
  for (const tab of get().unifiedTabsByWorktree[worktreeId] ?? []) {
    if (tab.contentType === 'agent-session') {
      get().closeUnifiedTab(tab.id, {
        preserveWorktreeSelection: true,
        recordInteraction: false
      })
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
  const runtimeCleanup = await cleanupEphemeralVmRuntimesForDeleted(
    requiredExecutionHostId
      ? {
          hostScopedWorkspaces: [
            { workspaceId: worktreeId, executionHostId: requiredExecutionHostId }
          ]
        }
      : { workspaceIds: [worktreeId] }
  )
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
  applyRemoveWorktreeSuccessState(set, worktreeId, tabIds, requiredExecutionHostId ?? hostId)
  get().removeWorkspaceSpaceWorktrees?.(
    hostId ? [{ id: worktreeId, executionHostId: hostId }] : [worktreeId]
  )
  // Why: PR/commit-message generation records are keyed by worktree; prune to the surviving set so they don't leak.
  const liveWorktreeKeys = new Set(
    get()
      .allWorktrees()
      .map((w) => w.id)
  )
  // Optional-chained: minimal store assemblies (some unit tests) omit the generation slices.
  get().prunePullRequestGenerationRecords?.(liveWorktreeKeys)
  get().pruneCommitMessageGenerationRecords?.(liveWorktreeKeys)
}
