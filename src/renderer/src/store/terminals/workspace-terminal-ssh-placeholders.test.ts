import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { addHydratedSshWorktreePlaceholders } from './workspace-terminal-ssh-placeholders'

function makeRepo(): Repo {
  return {
    id: 'repo-ssh',
    path: '/repo-ssh',
    displayName: 'SSH',
    badgeColor: '#fff',
    addedAt: 1,
    connectionId: 'ssh-1'
  }
}

function makeTab(worktreeId: string): TerminalTab {
  return {
    id: 'tab-ssh',
    title: 'remote',
    ptyId: null,
    worktreeId,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('addHydratedSshWorktreePlaceholders', () => {
  it('resolves canonical session keys to raw SSH worktree ids', () => {
    const rawWorktreeId = 'repo-ssh::/remote/worktree'
    const workspaceKey = worktreeWorkspaceKey(rawWorktreeId)

    const result = addHydratedSshWorktreePlaceholders(
      [makeRepo()],
      {},
      { [workspaceKey]: [makeTab(workspaceKey)] }
    )

    expect(result['repo-ssh']).toEqual([
      expect.objectContaining({ id: rawWorktreeId, path: '/remote/worktree' })
    ])
  })

  it('does not synthesize a row when local and SSH repos share an id', () => {
    const rawWorktreeId = 'repo-collision::/remote/worktree'
    const workspaceKey = worktreeWorkspaceKey(rawWorktreeId)
    const result = addHydratedSshWorktreePlaceholders(
      [
        { ...makeRepo(), connectionId: null, path: '/local/repo-collision', id: 'repo-collision' },
        { ...makeRepo(), id: 'repo-collision' }
      ],
      {},
      { [workspaceKey]: [makeTab(workspaceKey)] }
    )

    expect(result).toEqual({})
  })

  it('does not synthesize placeholders for folder or malformed scoped keys', () => {
    const result = addHydratedSshWorktreePlaceholders(
      [makeRepo()],
      {},
      {
        'folder:folder-1': [makeTab('folder:folder-1')],
        'worktree:': [makeTab('worktree:')],
        'worktree:repo-ssh': [makeTab('worktree:repo-ssh')],
        'worktree:repo-ssh::': [makeTab('worktree:repo-ssh::')]
      }
    )

    expect(result).toEqual({})
  })
})
