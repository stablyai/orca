import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { withGitHubCheckDetailsTimeout } from '@/runtime/github-check-details-timeout'
import {
  beginGitHubChecksTabDetails,
  settleGitHubChecksTabDetails,
  type CheckDetailsLoadState
} from '@/components/github-checks-tab-state'
import { getGitHubRuntimeRepoId } from '@/lib/github-source-runtime-context'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import { translate } from '@/i18n/i18n'
import type { ChecksTabActionContext } from './checks-tab-actions'

export function requestGitHubCheckDetails(
  ctx: ChecksTabActionContext,
  check: PRCheckDetail,
  key: string
): void {
  if (!ctx.canUseChecksRepoContext || (!check.checkRunId && !check.workflowRunId && !check.url)) {
    return
  }
  const requestId = ++ctx.nextCheckDetailsRequestIdRef.current
  const commit = (next: Omit<CheckDetailsLoadState, 'requestId'>): void => {
    if (!ctx.mountedRef.current) {
      return
    }
    ctx.setChecksState((current) => settleGitHubChecksTabDetails(current, key, requestId, next))
  }
  ctx.setChecksState((current) => beginGitHubChecksTabDetails(current, key, requestId))
  const detailsRequest = withGitHubCheckDetailsTimeout((signal) =>
    ctx.runtimeHost
      ? callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.prCheckDetails>>>(
          { kind: 'environment', environmentId: ctx.runtimeHost.environmentId },
          'github.prCheckDetails',
          {
            repo: getGitHubRuntimeRepoId(ctx.sourceContext, ctx.repoId ?? ctx.itemRepoId),
            checkRunId: check.checkRunId,
            workflowRunId: check.workflowRunId,
            checkName: check.name,
            url: check.url,
            prRepo: ctx.prRepo
          },
          { timeoutMs: 30_000, signal }
        )
      : window.api.gh.prCheckDetails({
          repoPath: ctx.repoPath ?? '',
          repoId: ctx.repoId ?? undefined,
          sourceContext: ctx.sourceContext,
          checkRunId: check.checkRunId,
          workflowRunId: check.workflowRunId,
          checkName: check.name,
          url: check.url,
          prRepo: ctx.prRepo
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
              'auto.components.GitHubItemDialog.e15a8b77ef',
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
                'auto.components.GitHubItemDialog.e45324fbed',
                'Failed to load check details.'
              )
      })
    })
}
