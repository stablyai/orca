import type { WorktreeSlice } from '../worktree-helpers'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  type RuntimeClientTarget
} from '../../../runtime/runtime-rpc-client'
import type { WorktreeSliceGet, WorktreeSliceSet } from './listing/worktree-slice-types'
import type {
  ForgetUnknownAgentLaunchResult,
  WorktreeRetryAgentLaunchResult
} from '../../../../../shared/agent-launch-worktree-recovery'
import type { PendingAgentLaunchSummary } from '../../../../../shared/agent-launch-pending-summary'
import { toRuntimeWorktreeSelector } from '../../../runtime/runtime-worktree-selector'
import { getRepoIdFromWorktreeId } from '../worktree-helpers'
import { settingsForRepoOwner } from './listing/worktree-owner-settings'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import {
  resolveWorktreeOperationRouteForHost,
  settingsForWorktreeOperationRoute
} from '@/lib/worktree-operation-route'

function targetForBackgroundRecovery(
  state: ReturnType<WorktreeSliceGet>,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): RuntimeClientTarget {
  if (executionHostId) {
    const route = resolveWorktreeOperationRouteForHost(state, worktreeId, executionHostId)
    if (!route) {
      throw new Error('The workspace host is no longer available.')
    }
    return getActiveRuntimeTarget(settingsForWorktreeOperationRoute(state.settings, route))
  }
  return getActiveRuntimeTarget(settingsForRepoOwner(state, getRepoIdFromWorktreeId(worktreeId)))
}

export function createWorktreeAgentLaunchActions(
  _set: WorktreeSliceSet,
  get: WorktreeSliceGet
): Pick<
  WorktreeSlice,
  | 'retryWorktreeAgentLaunch'
  | 'forgetWorktreeAgentLaunch'
  | 'retryBackgroundAgentLaunch'
  | 'forgetBackgroundAgentLaunch'
  | 'unknownAgentLaunchSiblingPreflight'
  | 'forgetUnknownAgentLaunchSiblings'
  | 'fetchPendingAgentLaunchSummary'
> {
  return {
    retryWorktreeAgentLaunch: async ({ worktreeId, expectedFailureId, action }) => {
      const repoId = getRepoIdFromWorktreeId(worktreeId)
      const clientMutationId = createBrowserUuid()
      const target = getActiveRuntimeTarget(settingsForRepoOwner(get(), repoId))
      if (target.kind === 'local') {
        return window.api.worktrees.retryAgentLaunch({
          worktreeId,
          expectedFailureId,
          clientMutationId,
          action
        })
      }
      return callRuntimeRpc<WorktreeRetryAgentLaunchResult>(
        target,
        'worktree.retryAgentLaunch',
        {
          worktree: toRuntimeWorktreeSelector(worktreeId),
          expectedFailureId,
          clientMutationId,
          action
        },
        { timeoutMs: 10 * 60_000 }
      )
    },

    forgetWorktreeAgentLaunch: async ({ worktreeId, expectedOperationId }) => {
      const repoId = getRepoIdFromWorktreeId(worktreeId)
      const clientMutationId = createBrowserUuid()
      const target = getActiveRuntimeTarget(settingsForRepoOwner(get(), repoId))
      if (target.kind === 'local') {
        return window.api.worktrees.forgetAgentLaunch({
          worktreeId,
          expectedOperationId,
          clientMutationId
        })
      }
      return callRuntimeRpc<ForgetUnknownAgentLaunchResult>(
        target,
        'worktree.forgetAgentLaunch',
        {
          worktree: toRuntimeWorktreeSelector(worktreeId),
          expectedOperationId,
          clientMutationId
        },
        { timeoutMs: 30_000 }
      )
    },

    retryBackgroundAgentLaunch: async ({
      attemptId,
      worktreeId,
      executionHostId,
      expectedFailureId,
      action
    }) => {
      const clientMutationId = createBrowserUuid()
      const target = targetForBackgroundRecovery(get(), worktreeId, executionHostId)
      if (target.kind === 'local') {
        return window.api.worktrees.retryBackgroundAgentLaunch({
          attemptId,
          expectedFailureId,
          clientMutationId,
          action
        })
      }
      return callRuntimeRpc<WorktreeRetryAgentLaunchResult>(
        target,
        'worktree.retryBackgroundAgentLaunch',
        { attemptId, expectedFailureId, clientMutationId, action },
        { timeoutMs: 10 * 60_000 }
      )
    },

    forgetBackgroundAgentLaunch: async ({
      attemptId,
      worktreeId,
      executionHostId,
      expectedOperationId
    }) => {
      const clientMutationId = createBrowserUuid()
      const target = targetForBackgroundRecovery(get(), worktreeId, executionHostId)
      if (target.kind === 'local') {
        return window.api.worktrees.forgetBackgroundAgentLaunch({
          attemptId,
          expectedOperationId,
          clientMutationId
        })
      }
      return callRuntimeRpc<ForgetUnknownAgentLaunchResult>(
        target,
        'worktree.forgetBackgroundAgentLaunch',
        { attemptId, expectedOperationId, clientMutationId },
        { timeoutMs: 30_000 }
      )
    },

    unknownAgentLaunchSiblingPreflight: async ({ worktreeId, executionHostId }) => {
      const target = targetForBackgroundRecovery(get(), worktreeId, executionHostId)
      if (target.kind === 'local') {
        const { count } = await window.api.worktrees.unknownAgentLaunchSiblingCount({ worktreeId })
        return { count, hostName: '' }
      }
      const { count } = await callRuntimeRpc<{ count: number }>(
        target,
        'worktree.unknownAgentLaunchSiblingCount',
        { worktree: toRuntimeWorktreeSelector(worktreeId) },
        { timeoutMs: 30_000 }
      )
      const environment = get().runtimeEnvironments.find(
        (entry) => entry.id === target.environmentId
      )
      return { count, hostName: environment?.name || target.environmentId }
    },

    forgetUnknownAgentLaunchSiblings: async ({ worktreeId, executionHostId }) => {
      const target = targetForBackgroundRecovery(get(), worktreeId, executionHostId)
      if (target.kind === 'local') {
        return window.api.worktrees.forgetUnknownAgentLaunchSiblings({ worktreeId })
      }
      return callRuntimeRpc<{ forgottenCount: number }>(
        target,
        'worktree.forgetUnknownAgentLaunchSiblings',
        { worktree: toRuntimeWorktreeSelector(worktreeId) },
        { timeoutMs: 30_000 }
      )
    },

    fetchPendingAgentLaunchSummary: async (target?: RuntimeClientTarget) => {
      if (!target || target.kind === 'local') {
        return window.api.worktrees.pendingAgentLaunchSummary()
      }
      return callRuntimeRpc<PendingAgentLaunchSummary>(
        target,
        'worktree.pendingAgentLaunchSummary',
        {},
        { timeoutMs: 30_000 }
      )
    }
  }
}
