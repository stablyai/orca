import type { ExecutionHostId } from '../../../shared/execution-host'

type TwinRepoRow = { id: string; connectionId?: string; executionHostId: ExecutionHostId }
type TwinWorktreeRow = { id: string; repoId: string; hostId: ExecutionHostId }

/** Repo and worktree rows for one project that this app and the SSH target `box` both publish. */
export function localAndSshTwinRows(
  repoId: string,
  worktreeId: string
): { repos: TwinRepoRow[]; worktreesByRepo: Record<string, TwinWorktreeRow[]> } {
  return {
    repos: [
      { id: repoId, executionHostId: 'local' },
      { id: repoId, connectionId: 'box', executionHostId: 'ssh:box' }
    ],
    worktreesByRepo: {
      [repoId]: [
        { id: worktreeId, repoId, hostId: 'local' },
        { id: worktreeId, repoId, hostId: 'ssh:box' }
      ]
    }
  }
}
