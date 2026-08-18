import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getGitHubRuntimeRepoId, type GitHubRuntimeHost } from '@/lib/github-source-runtime-context'
import { translate } from '@/i18n/i18n'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export async function rerunPullRequestChecks(args: {
  canUseChecksRepoContext: boolean
  rerunning: boolean
  committedChecksContextOwnerRef: { current: object }
  setRerunningOwner: (value: object | null | ((current: object | null) => object | null)) => void
  runtimeHost: GitHubRuntimeHost | null
  sourceContext?: TaskSourceContext | null
  repoId: string | null
  repoPath: string | null
  item: GitHubWorkItem
  headSha: string | undefined
  prRepo: GitHubOwnerRepo | null
  failedOnly: boolean
  mountedRef: { current: boolean }
  handleRefresh: (expectedContextOwner?: object) => Promise<PRCheckDetail[] | null>
}): Promise<void> {
  if (!args.canUseChecksRepoContext || args.rerunning) {
    return
  }
  const rerunContextOwner = args.committedChecksContextOwnerRef.current
  args.setRerunningOwner(rerunContextOwner)
  try {
    const result = args.runtimeHost
      ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.rerunPRChecks>>>(
          { kind: 'environment', environmentId: args.runtimeHost.environmentId },
          'github.rerunPRChecks',
          {
            repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId ?? args.item.repoId),
            prNumber: args.item.number,
            headSha: args.headSha,
            failedOnly: args.failedOnly,
            prRepo: args.prRepo
          },
          { timeoutMs: 30_000 }
        )
      : await window.api.gh.rerunPRChecks({
          repoPath: args.repoPath ?? '',
          repoId: args.repoId ?? undefined,
          sourceContext: args.sourceContext,
          prNumber: args.item.number,
          headSha: args.headSha,
          failedOnly: args.failedOnly,
          prRepo: args.prRepo
        })
    if (
      !args.mountedRef.current ||
      args.committedChecksContextOwnerRef.current !== rerunContextOwner
    ) {
      return
    }
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      result.count === 1
        ? translate('auto.components.PullRequestPage.5963a6a852', 'Check rerun requested')
        : translate('auto.components.PullRequestPage.18f2af42ac', 'Check reruns requested')
    )
    await args.handleRefresh(rerunContextOwner)
  } catch (err) {
    if (
      args.mountedRef.current &&
      args.committedChecksContextOwnerRef.current === rerunContextOwner
    ) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate('auto.components.PullRequestPage.788a782bb0', 'Failed to rerun checks')
      )
    }
  } finally {
    if (args.mountedRef.current) {
      args.setRerunningOwner((current) => (current === rerunContextOwner ? null : current))
    }
  }
}
