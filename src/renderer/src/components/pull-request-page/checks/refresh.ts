import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getGitHubRuntimeRepoId, type GitHubRuntimeHost } from '@/lib/github-source-runtime-context'
import {
  resetGitHubChecksTabForSource,
  updateGitHubChecksTabLocalChecks,
  type GitHubChecksTabState
} from '@/components/github-checks-tab-state'
import { translate } from '@/i18n/i18n'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export async function refreshPullRequestChecks(args: {
  canUseChecksRepoContext: boolean
  expectedContextOwner?: object
  committedChecksContextOwnerRef: { current: object }
  nextChecksRefreshRequestIdRef: { current: number }
  activeChecksRefreshRequestIdRef: { current: number | null }
  setRefreshingOwner: (
    value:
      | { contextOwner: object; requestId: number }
      | null
      | ((
          current: { contextOwner: object; requestId: number } | null
        ) => { contextOwner: object; requestId: number } | null)
  ) => void
  setChecksState: (updater: (current: GitHubChecksTabState) => GitHubChecksTabState) => void
  runtimeHost: GitHubRuntimeHost | null
  sourceContext?: TaskSourceContext | null
  repoId: string | null
  repoPath: string | null
  item: GitHubWorkItem
  headSha: string | undefined
  prRepo: GitHubOwnerRepo | null
  mountedRef: { current: boolean }
  onChecksUpdated: (checks: PRCheckDetail[]) => void
}): Promise<PRCheckDetail[] | null> {
  if (!args.canUseChecksRepoContext) {
    toast.error(
      translate(
        'auto.components.PullRequestPage.c057f2fcb0',
        'Unable to refresh checks without a repository path.'
      )
    )
    return null
  }
  const refreshContextOwner =
    args.expectedContextOwner ?? args.committedChecksContextOwnerRef.current
  if (args.committedChecksContextOwnerRef.current !== refreshContextOwner) {
    return null
  }
  const refreshRequestId = ++args.nextChecksRefreshRequestIdRef.current
  args.activeChecksRefreshRequestIdRef.current = refreshRequestId
  args.setRefreshingOwner({ contextOwner: refreshContextOwner, requestId: refreshRequestId })
  try {
    const nextChecks = (await (args.runtimeHost
      ? callRuntimeRpc<PRCheckDetail[]>(
          { kind: 'environment', environmentId: args.runtimeHost.environmentId },
          'github.prChecks',
          {
            repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId ?? args.item.repoId),
            prNumber: args.item.number,
            headSha: args.headSha,
            prRepo: args.prRepo,
            noCache: true
          },
          { timeoutMs: 30_000 }
        )
      : window.api.gh.prChecks({
          repoPath: args.repoPath ?? '',
          repoId: args.repoId ?? undefined,
          sourceContext: args.sourceContext,
          prNumber: args.item.number,
          headSha: args.headSha,
          prRepo: args.prRepo,
          noCache: true
        }))) as PRCheckDetail[]
    if (
      !args.mountedRef.current ||
      args.committedChecksContextOwnerRef.current !== refreshContextOwner ||
      args.activeChecksRefreshRequestIdRef.current !== refreshRequestId
    ) {
      return null
    }
    args.setChecksState((current) =>
      current.contextOwner === refreshContextOwner
        ? updateGitHubChecksTabLocalChecks(resetGitHubChecksTabForSource(current), nextChecks)
        : current
    )
    args.onChecksUpdated(nextChecks)
    return nextChecks
  } catch (err) {
    if (
      args.mountedRef.current &&
      args.committedChecksContextOwnerRef.current === refreshContextOwner &&
      args.activeChecksRefreshRequestIdRef.current === refreshRequestId
    ) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate('auto.components.PullRequestPage.246b2c6456', 'Failed to refresh checks')
      )
    }
    return null
  } finally {
    if (args.activeChecksRefreshRequestIdRef.current === refreshRequestId) {
      args.activeChecksRefreshRequestIdRef.current = null
    }
    if (args.mountedRef.current) {
      args.setRefreshingOwner((current) =>
        current?.requestId === refreshRequestId ? null : current
      )
    }
  }
}
