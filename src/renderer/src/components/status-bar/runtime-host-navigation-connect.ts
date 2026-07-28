import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/types'

export async function connectRuntimeHostForNavigation(args: {
  environmentId: string
  refreshStatus: (environmentId: string, timeoutMs: number) => Promise<boolean>
  fetchRepos: (
    environmentId: string
  ) => Promise<Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]>
  fetchWorktrees: (
    repoId: string,
    options: { executionHostId: ExecutionHostId }
  ) => Promise<unknown>
  fetchLineage: () => Promise<unknown>
}): Promise<boolean> {
  if (!(await args.refreshStatus(args.environmentId, 5_000))) {
    return false
  }
  const repos = await args.fetchRepos(args.environmentId)
  await Promise.all(
    repos.map((repo) =>
      args.fetchWorktrees(repo.id, { executionHostId: getRepoExecutionHostId(repo) })
    )
  )
  await args.fetchLineage()
  return true
}
