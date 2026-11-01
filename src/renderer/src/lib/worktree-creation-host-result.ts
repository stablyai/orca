import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { applyCreatedWorktree } from '@/store/slices/worktrees/create/created-worktree-state-merge'
import { holdCreatedSidebarWorkspace } from '@/lib/sidebar-pending-layer'
import { showLocalBaseRefRefreshToast } from '@/store/slices/worktrees/create/local-base-ref-refresh-toast'
import { requestWorktreeBaseFallbackNotice } from '@/components/worktree-base-fallback-notice'
import { showLocalBaseRefUpdateSuggestionToast } from '@/components/sidebar/local-base-ref-suggestion-toast'
import type { AgentLaunchResult } from '../../../shared/agent-launch-intent'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'

export async function acceptHostCreatedWorktree(
  target: RuntimeClientTarget,
  launch: Pick<AgentLaunchResult, 'worktreeId' | 'created'>,
  repoId: string,
  executionHostId: ExecutionHostId,
  showNotices: () => boolean = () => true,
  isCurrent: () => boolean = () => true,
  expectedEnvironmentPairingRevision?: number
): Promise<CreateWorktreeResult> {
  if (!isCurrent()) {
    throw new Error('agent_session_operation_unknown')
  }
  const result =
    launch.created ??
    (await callRuntimeRpc<CreateWorktreeResult>(
      target,
      'worktree.show',
      {
        worktree: `id:${launch.worktreeId}`
      },
      { expectedEnvironmentPairingRevision }
    ))
  if (
    !isCurrent() ||
    result.worktree.id !== launch.worktreeId ||
    result.worktree.repoId !== repoId
  ) {
    throw new Error('agent_session_operation_unknown')
  }
  applyCreatedWorktree(useAppStore.setState, repoId, result, executionHostId)
  const state = useAppStore.getState()
  const created = state.getKnownWorktreeById(result.worktree.id, executionHostId)
  if (created) {
    holdCreatedSidebarWorkspace({ worktree: created })
  }
  if (showNotices()) {
    showLocalBaseRefRefreshToast(result.localBaseRefRefresh, result.worktree, {
      updateSettings: state.updateSettings,
      executionHostId
    })
    if (result.baseFallback) {
      requestWorktreeBaseFallbackNotice(result.baseFallback)
    }
    showLocalBaseRefUpdateSuggestionToast(result.localBaseRefUpdateSuggestion, {
      updateSettings: state.updateSettings,
      getSettings: () => useAppStore.getState().settings,
      openSettingsPage: state.openSettingsPage,
      openSettingsTarget: state.openSettingsTarget
    })
  }
  if (!launch.created) {
    void state.fetchWorktrees(repoId, { executionHostId }).catch((error: unknown) => {
      console.warn('worktree create: catalog refresh failed', error)
    })
  }
  return result
}

/** Refresh through the normal inventory fences; a launch result never opens a provisional tab. */
export async function materializeHostCreatedWorktree(
  target: RuntimeClientTarget,
  worktreeId: string,
  expectedEnvironmentPairingRevision?: number
): Promise<void> {
  if (target.kind === 'local') {
    const { refreshLocalStructuredSessionWorktreeTabs } =
      await import('@/runtime/local-structured-session-tabs-sync/inventory-refresh')
    const { materializeWorkspaceInitialSurface } =
      await import('@/runtime/workspace-initial-surface-materialization')
    const snapshot = await refreshLocalStructuredSessionWorktreeTabs(worktreeId)
    if (snapshot) {
      materializeWorkspaceInitialSurface(
        { worktreeId, initialWorkspaceTopology: snapshot },
        { appendAncillary: false }
      )
    }
  } else {
    const { refreshWebRuntimeSessionTabsSnapshot } =
      await import('@/runtime/web-runtime-session-snapshot')
    await refreshWebRuntimeSessionTabsSnapshot(target.environmentId, worktreeId, {
      expectedEnvironmentPairingRevision
    })
  }
}
