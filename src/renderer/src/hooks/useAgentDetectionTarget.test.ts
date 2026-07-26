import { describe, expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { getAgentDetectionTargetKeyForWorktree } from './useAgentDetectionTarget'

describe('getAgentDetectionTargetKeyForWorktree', () => {
  it('uses an explicit runtime owner without scanning ambiguous child SSH repos', () => {
    let projectGroupReads = 0
    const repos = Array.from({ length: 100 }, (_, index) => {
      const repo = {
        id: `repo-${index}`,
        connectionId: `ssh-${index}`,
        executionHostId: `ssh:ssh-${index}`,
        path: `/workspace/repo-${index}`
      }
      Object.defineProperty(repo, 'projectGroupId', {
        enumerable: true,
        get: () => {
          projectGroupReads += 1
          return 'runtime-group'
        }
      })
      return repo
    })
    const state = {
      settings: { activeRuntimeEnvironmentId: 'focused-env' },
      folderWorkspaces: [
        {
          id: 'runtime-folder',
          projectGroupId: 'runtime-group',
          folderPath: '/workspace'
        }
      ],
      projectGroups: [
        {
          id: 'runtime-group',
          connectionId: null,
          executionHostId: 'runtime:owner-env'
        }
      ],
      repos,
      worktreesByRepo: {}
    } as Parameters<typeof getAgentDetectionTargetKeyForWorktree>[0]

    expect(getAgentDetectionTargetKeyForWorktree(state, folderWorkspaceKey('runtime-folder'))).toBe(
      'runtime:owner-env'
    )
    expect(projectGroupReads).toBe(0)
  })

  it('stays unresolved when ownership records have not hydrated', () => {
    const state = {
      settings: { activeRuntimeEnvironmentId: 'focused-env' },
      folderWorkspaces: [],
      projectGroups: [],
      repos: [],
      worktreesByRepo: {}
    } as Parameters<typeof getAgentDetectionTargetKeyForWorktree>[0]

    expect(getAgentDetectionTargetKeyForWorktree(state, 'missing-worktree')).toBeUndefined()
  })

  it('does not trust a repo owner before the requested worktree hydrates', () => {
    const state = {
      settings: { activeRuntimeEnvironmentId: null },
      folderWorkspaces: [],
      projectGroups: [],
      repos: [
        {
          id: 'repo-1',
          connectionId: null,
          executionHostId: 'local'
        }
      ],
      worktreesByRepo: {}
    } as unknown as Parameters<typeof getAgentDetectionTargetKeyForWorktree>[0]

    expect(getAgentDetectionTargetKeyForWorktree(state, 'repo-1::/remote/worktree')).toBeUndefined()
  })

  it('keeps the active runtime fallback for hydrated legacy worktrees', () => {
    const state = {
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      folderWorkspaces: [],
      projectGroups: [],
      repos: [{ id: 'repo-1', connectionId: null, executionHostId: null }],
      worktreesByRepo: {
        'repo-1': [{ id: 'repo-1::worktree-1', repoId: 'repo-1' }]
      }
    } as unknown as Parameters<typeof getAgentDetectionTargetKeyForWorktree>[0]

    expect(getAgentDetectionTargetKeyForWorktree(state, 'repo-1::worktree-1')).toBe('runtime:env-1')
  })

  it('builds one owner index per cold worktree and repo snapshot', () => {
    let worktreeIdReads = 0
    let repoIdReads = 0
    const repos = Array.from({ length: 100 }, (_, index) => {
      const repo = {
        connectionId: null,
        executionHostId: 'local'
      }
      Object.defineProperty(repo, 'id', {
        enumerable: true,
        get: () => {
          repoIdReads += 1
          return `repo-${index}`
        }
      })
      return repo
    })
    const worktrees = Array.from({ length: 100 }, (_, index) => {
      const worktree = {
        repoId: `repo-${index}`,
        hostId: undefined
      }
      Object.defineProperty(worktree, 'id', {
        enumerable: true,
        get: () => {
          worktreeIdReads += 1
          return `worktree-${index}`
        }
      })
      return worktree
    })
    const state = {
      settings: { activeRuntimeEnvironmentId: null },
      folderWorkspaces: [],
      projectGroups: [],
      repos,
      worktreesByRepo: { all: worktrees }
    } as unknown as Parameters<typeof getAgentDetectionTargetKeyForWorktree>[0]

    expect(getAgentDetectionTargetKeyForWorktree(state, 'worktree-99')).toBe('local')
    expect(worktreeIdReads).toBe(100)
    expect(repoIdReads).toBe(100)
  })
})
