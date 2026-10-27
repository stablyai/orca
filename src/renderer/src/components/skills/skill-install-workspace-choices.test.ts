import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { skillInstallWorkspaceChoices } from './skill-install-workspace-choices'

describe('skillInstallWorkspaceChoices', () => {
  it('includes SSH worktrees whose legacy host identity is inherited from the repo', () => {
    const repo = {
      id: 'repo_1',
      connectionId: 'ssh_1',
      executionHostId: 'ssh:ssh_1'
    } as unknown as Repo
    const worktree = {
      id: 'repo_1::/remote/worktree',
      repoId: repo.id,
      displayName: 'Remote worktree'
    } as Worktree
    expect(
      skillInstallWorkspaceChoices({
        environmentId: 'ssh:ssh_1',
        repos: [repo],
        worktreesByRepo: { [repo.id]: [worktree] },
        folderWorkspaces: []
      })
    ).toEqual([{ id: worktree.id, label: worktree.displayName, kind: 'worktree' }])
  })
})
