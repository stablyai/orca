import { toast } from 'sonner'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { notifyWorkItemDetailsMutation } from '@/components/github/github-work-item-comment-mutations'
import { getGitHubRuntimeRepoId } from '@/lib/github-source-runtime-context'
import { translate } from '@/i18n/i18n'
import {
  GITHUB_UPDATE_PR_BRANCH_RUNTIME_CAPABILITY,
  GITHUB_UPDATE_PR_BRANCH_UPDATE_REQUIRED_MESSAGE
} from '../../../../../shared/protocol-version'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

/** GitHub's "Update branch": merge base into the PR head when the branch is behind, for either a local or runtime-environment target. */
export async function updatePullRequestBranch(args: {
  item: GitHubWorkItem
  repoPath: string | null
  repoId: string | null
  sourceContext?: TaskSourceContext | null
  prRepo: GitHubOwnerRepo | null
  mergeTarget: RuntimeClientTarget
  setMergePending: (value: boolean) => void
  onMutated: () => void
}): Promise<void> {
  args.setMergePending(true)
  try {
    if (args.mergeTarget.kind === 'environment') {
      await assertRuntimeEnvironmentCapability(
        args.mergeTarget.environmentId,
        GITHUB_UPDATE_PR_BRANCH_RUNTIME_CAPABILITY,
        GITHUB_UPDATE_PR_BRANCH_UPDATE_REQUIRED_MESSAGE
      )
    }
    const result =
      args.mergeTarget.kind === 'environment'
        ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.updatePRBranch>>>(
            args.mergeTarget,
            'github.updatePRBranch',
            {
              repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId ?? args.item.repoId),
              prNumber: args.item.number,
              prRepo: args.prRepo
            },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.updatePRBranch({
            repoPath: args.repoPath ?? '',
            repoId: args.repoId ?? undefined,
            sourceContext: args.sourceContext,
            prNumber: args.item.number,
            prRepo: args.prRepo
          })
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    if (args.mergeTarget.kind === 'environment') {
      notifyWorkItemDetailsMutation(
        {
          repoPath: args.repoPath ?? '',
          repoId: args.item.repoId,
          sourceContext: args.sourceContext,
          type: 'pr',
          number: args.item.number
        },
        { local: false }
      )
    }
    toast.success(
      translate('auto.components.PullRequestPage.updateBranchSucceeded', 'Branch update started')
    )
    args.onMutated()
  } catch (err) {
    toast.error(
      err instanceof Error
        ? err.message
        : translate('auto.components.PullRequestPage.updateBranchFailed', 'Failed to update branch')
    )
  } finally {
    args.setMergePending(false)
  }
}
