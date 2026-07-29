import { describe, expect, it } from 'vitest'
import { collectLocalWorkspaceCandidates } from './os-requested-file-workspace-candidates'

describe('collectLocalWorkspaceCandidates', () => {
  it('includes a local worktree containing the path', () => {
    const state = {
      worktreesByRepo: {
        'local-repo': [{ id: 'wt-local', path: '/Users/x/projects/orca', repoId: 'local-repo' }]
      },
      folderWorkspaces: []
    }
    expect(collectLocalWorkspaceCandidates(state)).toEqual([
      { id: 'wt-local', path: '/Users/x/projects/orca' }
    ])
  })

  it('excludes a remote/runtime-owned worktree containing the path', () => {
    const state = {
      worktreesByRepo: {
        'runtime-repo': [
          {
            id: 'wt-remote',
            path: '/Users/x/projects/orca',
            repoId: 'runtime-repo',
            hostId: 'runtime:env-1' as const
          }
        ]
      },
      folderWorkspaces: []
    }
    expect(collectLocalWorkspaceCandidates(state)).toEqual([])
  })

  it('includes a local folder workspace containing the path', () => {
    const state = {
      worktreesByRepo: {},
      folderWorkspaces: [
        {
          id: 'fw-local',
          folderPath: '/Users/x/Downloads',
          connectionId: null,
          projectGroupId: 'group-local'
        }
      ]
    }
    expect(collectLocalWorkspaceCandidates(state)).toEqual([
      { id: 'folder:fw-local', path: '/Users/x/Downloads' }
    ])
  })

  it('excludes an SSH-owned folder workspace (truthy connectionId) containing the path', () => {
    const state = {
      worktreesByRepo: {},
      folderWorkspaces: [
        {
          id: 'fw-remote',
          folderPath: '/Users/x/Downloads',
          connectionId: 'ssh-host-1',
          projectGroupId: 'group-remote'
        }
      ]
    }
    expect(collectLocalWorkspaceCandidates(state)).toEqual([])
  })

  it('keeps only the local candidate when a remote and a local candidate both contain the path', () => {
    const state = {
      worktreesByRepo: {
        'local-repo': [{ id: 'wt-local', path: '/Users/x/projects/orca', repoId: 'local-repo' }],
        'runtime-repo': [
          {
            id: 'wt-remote',
            path: '/Users/x/projects/orca',
            repoId: 'runtime-repo',
            hostId: 'runtime:env-1' as const
          }
        ]
      },
      folderWorkspaces: []
    }
    expect(collectLocalWorkspaceCandidates(state).map((candidate) => candidate.id)).toEqual([
      'wt-local'
    ])
  })
})
