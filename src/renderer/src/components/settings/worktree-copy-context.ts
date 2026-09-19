import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { getRepoMainWorktreeId } from '../../../../shared/worktree/id'
import type { Repo } from '../../../../shared/repo-types'

export function worktreeCopyContext(repo: Repo) {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return {
    settings: { activeRuntimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null },
    worktreeId: getRepoMainWorktreeId(repo),
    worktreePath: repo.path,
    connectionId: repo.connectionId ?? (host?.kind === 'ssh' ? host.targetId : undefined)
  }
}
