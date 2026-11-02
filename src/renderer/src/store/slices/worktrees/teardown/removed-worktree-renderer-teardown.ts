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
import { deleteWorkspaceChatDrafts } from './removed-worktree-chat-drafts'
import {
  flushPurgedWorkspaceEdits,
  type ConfirmedUnsavedDiscards
} from './removed-workspace-unsaved-files'
import { forgetDesktopCreatedServerTabsOf } from '@/lib/desktop-created-server-tabs'
import type { WorktreeStateBeforeRemoval } from './worktree-state-before-removal'

/** After backend success: unregister browsers before other teardown, then dispose SSH relay only after terminals so mounted panes cannot hit a missing relay. */
export async function tearDownRemovedWorktreeRendererState(args: {
  set: WorktreeSliceSet
  get: WorktreeSliceGet
  worktreeId: string
  hostId: ExecutionHostId | undefined
  requiredExecutionHostId: ExecutionHostId | null
  beforeRemoval: WorktreeStateBeforeRemoval
  /** The catalog the host's removal produced, when the host stamps it. */
  catalogVersion?: WorktreeCatalogVersion
  confirmedDiscards?: ConfirmedUnsavedDiscards
}): Promise<void> {
  const { set, get, worktreeId, hostId, requiredExecutionHostId, beforeRemoval } = args
  // Record removal version before await so earlier listings cannot restore its row.
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
  // Why the captured keys: closing a structured chat keeps its conversation's draft, and a listing
  // refresh may already have dropped these tabs.
  deleteWorkspaceChatDrafts(beforeRemoval.chatDraftKeys)
  forgetDesktopCreatedServerTabsOf(worktreeId)
  for (const tab of get().unifiedTabsByWorktree[worktreeId] ?? []) {
    if (tab.contentType === 'agent-session') {
      get().closeUnifiedTab(tab.id, {
        preserveWorktreeSelection: true,
        recordInteraction: false
      })
    }
  }
  // Only successful backend removal retires surfaces; browsers unregister first. Selection follows row removal when successor is chosen.
  await Promise.resolve(
    get().shutdownWorktreeBrowsers(worktreeId, { preserveWorktreeSelection: true })
  )
  // Why here too: an SSH or paired workspace's pages use this desktop's profile, which that host's removal never reaches.
  void get().deleteManagedBrowserSessionProfile({ kind: 'worktree', id: worktreeId })
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
  const tabs = get().tabsByWorktree[worktreeId] ?? []
  const tabIds = new Set(tabs.map((t) => t.id))

  for (const tabId of tabIds) {
    get().closeDetachedTerminalWindow(tabId)
  }

  // Why: this path deletes tabsByWorktree wholesale (not via closeTab), so purge the module-level tab maps here too.
  detachedHeadAutoDerivedDisplayNames.delete(worktreeId)
  forgetForegroundTerminalTabs(tabIds)
  forgetAgentStartupDeliveriesForTabs(tabIds)

  // Why: snapshot the sidebar top-row anchor in the same tick we remove the row; recording at click time goes stale across the await.
  requestVirtualizedScrollAnchorRecord('[data-worktree-sidebar]')

  // Why: dispose parked terminal watchers only on explicit deletion; identity migration/remounts must keep buffered PTY state.
  disposeRemovedWorktreeParkedTerminalWatchers(worktreeId, beforeRemoval.terminalPtyIds)
  // Why: delayed views must commit text the teardown may offer back.
  flushPurgedWorkspaceEdits(get(), [{ id: worktreeId }])
  applyRemoveWorktreeSuccessState(
    set,
    worktreeId,
    tabIds,
    requiredExecutionHostId ?? hostId,
    args.confirmedDiscards
  )
  // Purge destroyed-target projects after row removal so selection clears with the row, not earlier.
  await purgeOrphanedRuntimeSshProjects(get, runtimeCleanup.destroyedSshTargetIds)
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
