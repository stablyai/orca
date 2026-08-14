import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  getAgentDetectionTargetKeyForWorktree,
  parseAgentDetectionTargetKey
} from './useAgentDetectionTarget'

describe('getAgentDetectionTargetKeyForWorktree', () => {
  it('carries explicit local Floating Workspace authority into detection', () => {
    const state = {
      settings: { activeRuntimeEnvironmentId: 'active-wsl-project' },
      folderWorkspaces: [],
      projectGroups: [],
      repos: [],
      worktreesByRepo: {}
    } as Parameters<typeof getAgentDetectionTargetKeyForWorktree>[0]

    const key = getAgentDetectionTargetKeyForWorktree(state, FLOATING_TERMINAL_WORKTREE_ID)

    expect(parseAgentDetectionTargetKey(key)).toEqual({
      kind: 'local',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      contextKey: 'host'
    })
  })

  it('uses an explicit runtime owner without scanning ambiguous child SSH repos', () => {
    let projectGroupReads = 0
    const repos: readonly Repo[] = Array.from({ length: 100 }, (_, index) => {
      const repo: Repo = {
        id: `repo-${index}`,
        connectionId: `ssh-${index}`,
        executionHostId: `ssh:ssh-${index}`,
        path: `/workspace/repo-${index}`,
        displayName: `repo-${index}`,
        badgeColor: 'blue',
        addedAt: 1
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
        } as FolderWorkspace
      ],
      projectGroups: [
        {
          id: 'runtime-group',
          connectionId: null,
          executionHostId: 'runtime:owner-env'
        } as ProjectGroup
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

describe('parseAgentDetectionTargetKey', () => {
  it.each(['local:missing-context', 'local:%:host'])(
    'falls back to unscoped local detection for malformed key %s',
    (key) => {
      expect(parseAgentDetectionTargetKey(key)).toEqual({ kind: 'local' })
    }
  )
})
