import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { withGitHubCheckDetailsTimeout } from '@/runtime/github-check-details-timeout'
import {
  beginGitHubChecksTabDetails,
  settleGitHubChecksTabDetails,
  type CheckDetailsLoadState,
  type GitHubChecksTabState
} from '@/components/github-checks-tab-state'
import { getGitHubRuntimeRepoId, type GitHubRuntimeHost } from '@/lib/github-source-runtime-context'
import { translate } from '@/i18n/i18n'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export function requestPullRequestCheckDetails(args: {
  canUseChecksRepoContext: boolean
  check: PRCheckDetail
  key: string
  nextCheckDetailsRequestIdRef: { current: number }
  mountedRef: { current: boolean }
  setChecksState: (updater: (current: GitHubChecksTabState) => GitHubChecksTabState) => void
  runtimeHost: GitHubRuntimeHost | null
  sourceContext?: TaskSourceContext | null
  repoId: string | null
  repoPath: string | null
  item: GitHubWorkItem
  prRepo: GitHubOwnerRepo | null
}): void {
  if (
    !args.canUseChecksRepoContext ||
    (!args.check.checkRunId && !args.check.workflowRunId && !args.check.url)
  ) {
    return
  }
  const requestId = ++args.nextCheckDetailsRequestIdRef.current
  const commit = (next: Omit<CheckDetailsLoadState, 'requestId'>): void => {
    if (!args.mountedRef.current) {
      return
    }
    args.setChecksState((current) =>
      settleGitHubChecksTabDetails(current, args.key, requestId, next)
    )
  }
  args.setChecksState((current) => beginGitHubChecksTabDetails(current, args.key, requestId))
  const detailsRequest = withGitHubCheckDetailsTimeout((signal) =>
    args.runtimeHost
      ? callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.prCheckDetails>>>(
          { kind: 'environment', environmentId: args.runtimeHost.environmentId },
          'github.prCheckDetails',
          {
            repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId ?? args.item.repoId),
            checkRunId: args.check.checkRunId,
            workflowRunId: args.check.workflowRunId,
            checkName: args.check.name,
            url: args.check.url,
            prRepo: args.prRepo
          },
          { timeoutMs: 30_000, signal }
        )
      : window.api.gh.prCheckDetails({
          repoPath: args.repoPath ?? '',
          repoId: args.repoId ?? undefined,
          sourceContext: args.sourceContext,
          checkRunId: args.check.checkRunId,
          workflowRunId: args.check.workflowRunId,
          checkName: args.check.name,
          url: args.check.url,
          prRepo: args.prRepo
        })
  )
  void detailsRequest
    .then((details) => {
      commit({
        loading: false,
        details,
        error: details
          ? null
          : translate(
              'auto.components.PullRequestPage.6b1d5ee3e4',
              'No inline details are available for this check.'
            )
      })
    })
    .catch((err) => {
      commit({
        loading: false,
        details: null,
        error:
          err instanceof Error
            ? err.message
            : translate(
                'auto.components.PullRequestPage.e04c027d98',
                'Failed to load check details.'
              )
      })
    })
}
