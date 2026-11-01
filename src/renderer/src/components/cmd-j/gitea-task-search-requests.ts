import { useAppStore } from '@/store'
import { resolveGiteaWorkItemsForQuery } from '@/lib/gitea-work-item-source-lookup'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { getTaskEligibleRepos } from '../task-page/task-page-default-repo-selection'
import { getTaskPageRepoSourceContext } from '../task-page/task-page-source-context'
import { canUseGiteaSmartSource } from '../new-workspace/smart-workspace-provider-availability'
import { makeCmdJTaskSearchResult } from './task-search-results'
import type { CmdJTaskSearchRequest } from './task-search-requests'

const RESULT_LIMIT = 12

export function createCmdJGiteaTaskSearchRequests(args: {
  query: string
  repos: readonly Repo[]
  signal: AbortSignal
  hostLabels: ReadonlyMap<string, string>
}): CmdJTaskSearchRequest[] {
  const { query, signal, hostLabels } = args
  const state = useAppStore.getState()
  const requests: CmdJTaskSearchRequest[] = []
  for (const repo of getTaskEligibleRepos(args.repos)) {
    // Why: Gitea is searched for every repo whose host can run `tea`, regardless of visible providers.
    const source = getTaskPageRepoSourceContext(repo, 'gitea')
    if (!source) {
      continue
    }
    if (
      !canUseGiteaSmartSource({
        giteaEnabled: true,
        localGiteaAvailable:
          source.hostId === 'local' &&
          state.preflightStatusChecked &&
          (state.preflightStatus?.tea?.installed === true ||
            state.preflightStatus?.gitea?.authenticated === true),
        repoBackedSourcesDisabled: false,
        remoteHost: repo.gitRemoteIdentity?.canonicalKey.split('/')[0],
        sourceHostId: source.hostId
      })
    ) {
      continue
    }
    const hostLabel = hostLabels.get(source.hostId) ?? source.hostId
    requests.push({
      id: `gitea:${source.hostId}:${repo.id}`,
      provider: 'gitea',
      hostLabel,
      run: async () => {
        if (signal.aborted) {
          return []
        }
        const items = await resolveGiteaWorkItemsForQuery({
          repoPath: repo.path,
          repoId: repo.id,
          repoOwnerExecutionHostId: getRepoExecutionHostId(repo),
          state: 'opened',
          page: 1,
          perPage: RESULT_LIMIT,
          query
        })
        return items
          .filter((issue) => issue.type === 'issue' && issue.state === 'open')
          .map((issue) =>
            makeCmdJTaskSearchResult(
              { provider: 'gitea', issue: { ...issue, repoId: repo.id } },
              source,
              repo.id,
              hostLabel
            )
          )
      }
    })
  }
  return requests
}
