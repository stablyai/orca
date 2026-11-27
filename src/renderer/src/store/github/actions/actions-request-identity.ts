import type { Repo } from '../../../../../shared/repository/repo-types'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
/** Invalidate repository probes and open-run ownership when the execution host or configured account changes. */
export function actionsRepoProbeKey(repo: Repo): string {
  return JSON.stringify([
    repo.id,
    repo.path,
    getRepoExecutionHostId(repo),
    repo.ghAccount,
    repo.gitRemoteIdentity
  ])
}
