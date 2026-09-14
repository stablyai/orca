import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
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

  it('keeps local, paired-runtime, and SSH workspace catalogs isolated', () => {
    const folders = [
      { id: 'local', name: 'Local', folderPath: '/local', executionHostId: 'local' },
      {
        id: 'runtime',
        name: 'Runtime',
        folderPath: '/runtime',
        executionHostId: 'runtime:environment_1'
      },
      { id: 'ssh', name: 'SSH', folderPath: '/ssh', executionHostId: 'ssh:ssh_1' }
    ] as FolderWorkspace[]
    const input = { repos: [], worktreesByRepo: {}, folderWorkspaces: folders }
    expect(skillInstallWorkspaceChoices({ ...input, environmentId: 'local' })).toHaveLength(1)
    expect(skillInstallWorkspaceChoices({ ...input, environmentId: 'environment_1' })).toHaveLength(
      1
    )
    expect(skillInstallWorkspaceChoices({ ...input, environmentId: 'ssh:ssh_1' })).toHaveLength(1)
  })
})
