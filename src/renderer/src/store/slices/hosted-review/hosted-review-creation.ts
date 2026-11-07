import type { AppState } from '../../types'
import type { HostedReviewSlice } from './hosted-review'
import type {
  CreateHostedReviewResult,
  CreateStackedHostedReviewResult
} from '../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  findHostedReviewRepoByPath,
  hostedReviewRepoOwnerTarget
} from './hosted-review-cache-state'

export function createHostedReviewCreation(
  get: () => AppState
): Pick<HostedReviewSlice, 'createHostedReview' | 'createStackedHostedReview'> {
  return {
    createHostedReview: async (repoPath, input) => {
      const repo = findHostedReviewRepoByPath(
        get().repos,
        repoPath,
        input.repoId,
        input.repoOwnerExecutionHostId
      )
      const target = hostedReviewRepoOwnerTarget(repo)
      const {
        repoId: inputRepoId,
        repoOwnerExecutionHostId: _ownerHostId,
        ...hostedReviewInput
      } = input
      if (target.kind === 'environment') {
        const { worktreePath, ...runtimeInput } = hostedReviewInput
        return callRuntimeRpc<CreateHostedReviewResult>(
          target,
          'hostedReview.create',
          {
            repo: repo?.id ?? repoPath,
            ...(worktreePath ? { worktree: `path:${worktreePath}` } : {}),
            ...runtimeInput
          },
          { timeoutMs: 60_000 }
        )
      }
      return window.api.hostedReview.create({
        repoPath,
        repoId: repo?.id ?? inputRepoId ?? undefined,
        connectionId: repo?.connectionId ?? null,
        ...hostedReviewInput
      })
    },

    createStackedHostedReview: async (repoPath, input) => {
      const repo = findHostedReviewRepoByPath(
        get().repos,
        repoPath,
        input.repoId,
        input.repoOwnerExecutionHostId
      )
      const target = hostedReviewRepoOwnerTarget(repo)
      const {
        repoId: inputRepoId,
        repoOwnerExecutionHostId: _ownerHostId,
        ...hostedReviewInput
      } = input
      if (target.kind === 'environment') {
        const { worktreePath, ...runtimeInput } = hostedReviewInput
        return callRuntimeRpc<CreateStackedHostedReviewResult>(
          target,
          'hostedReview.createStacked',
          {
            repo: repo?.id ?? repoPath,
            ...(worktreePath ? { worktree: `path:${worktreePath}` } : {}),
            ...runtimeInput
          },
          { timeoutMs: 90_000 }
        )
      }
      return window.api.hostedReview.createStacked({
        repoPath,
        repoId: repo?.id ?? inputRepoId ?? undefined,
        connectionId: repo?.connectionId ?? null,
        ...hostedReviewInput
      })
    }
  }
}
