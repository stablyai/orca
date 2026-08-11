import { describe, expect, it } from 'vitest'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import {
  resolveDirectSshTargetScope,
  type DirectSshTargetScopeInput
} from './direct-ssh-target-scope'

const baseInput: DirectSshTargetScopeInput = {
  targetId: 'target-a',
  catalogRevision: 17,
  repos: []
}

describe('resolveDirectSshTargetScope', () => {
  it('resolves duplicate repo IDs by exact SSH host instead of first wins', () => {
    const scope = resolveDirectSshTargetScope({
      ...baseInput,
      repos: [
        {
          id: 'shared',
          path: '/local/shared',
          projectGroupId: null,
          connectionId: null,
          executionHostId: 'local'
        },
        {
          id: 'shared',
          path: '/remote/shared',
          projectGroupId: null,
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      worktreesByRepo: {
        shared: [
          {
            id: 'shared::remote',
            repoId: 'shared',
            hostId: 'ssh:target-a'
          }
        ]
      }
    })

    expect(scope.catalogRevision).toBe(17)
    expect(scope.gitRepos).toEqual([{ repoId: 'shared', executionHostId: 'ssh:target-a' }])
    expect(scope.gitWorktreeIds).toEqual(new Set(['shared::remote']))
    expect(scope.terminalWorkspaceKeys).toEqual(new Set(['shared::remote']))
    expect(scope.lineageWorkspaceKeys).toEqual(new Set([worktreeWorkspaceKey('shared::remote')]))
    expect(scope.ambiguousOwnerCount).toBe(0)
    expect(scope.contradictoryOwnerCount).toBe(0)
  })

  it('keeps duplicate same-host repo owners ambiguous', () => {
    const duplicate = {
      id: 'duplicate',
      path: '/remote/duplicate',
      projectGroupId: null,
      connectionId: 'target-a',
      executionHostId: 'ssh:target-a' as const
    }
    const scope = resolveDirectSshTargetScope({
      ...baseInput,
      repos: [duplicate, { ...duplicate }],
      worktreesByRepo: {
        duplicate: [
          {
            id: 'duplicate::worktree',
            repoId: 'duplicate',
            hostId: 'ssh:target-a'
          }
        ]
      }
    })

    expect(scope.gitRepos).toEqual([])
    expect(scope.gitWorktreeIds.size).toBe(0)
    expect(scope.terminalWorkspaceKeys.size).toBe(0)
    expect(scope.ambiguousOwnerCount).toBe(2)
  })

  it('gives folder workspaces the same exact target isolation as Git worktrees', () => {
    const scope = resolveDirectSshTargetScope({
      ...baseInput,
      repos: [
        {
          id: 'remote-repo',
          path: '/srv/project/repo',
          projectGroupId: 'remote-group',
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      worktreesByRepo: {
        'remote-repo': [
          {
            id: 'remote-repo::worktree',
            repoId: 'remote-repo',
            hostId: 'ssh:target-a'
          }
        ]
      },
      projectGroups: [
        {
          id: 'remote-group',
          parentGroupId: null,
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      folderWorkspaces: [
        {
          id: 'remote-folder',
          projectGroupId: 'remote-group',
          folderPath: '/srv/project',
          connectionId: 'target-a'
        }
      ]
    })

    expect(scope.gitWorktreeIds).toEqual(new Set(['remote-repo::worktree']))
    expect(scope.terminalWorkspaceKeys).toEqual(
      new Set(['remote-repo::worktree', 'folder:remote-folder'])
    )
    expect(scope.lineageWorkspaceKeys).toEqual(
      new Set([worktreeWorkspaceKey('remote-repo::worktree'), folderWorkspaceKey('remote-folder')])
    )
  })

  it('keeps an explicit-local folder out of its SSH group target scope', () => {
    const scope = resolveDirectSshTargetScope({
      ...baseInput,
      repos: [
        {
          id: 'remote-repo',
          path: '/srv/project/repo',
          projectGroupId: 'remote-group',
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      projectGroups: [
        {
          id: 'remote-group',
          parentGroupId: null,
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      folderWorkspaces: [
        {
          id: 'local-folder',
          projectGroupId: 'remote-group',
          folderPath: '/srv/project',
          connectionId: null
        }
      ]
    })

    expect(scope.terminalWorkspaceKeys.size).toBe(0)
    expect(scope.ambiguousOwnerCount).toBe(0)
    expect(scope.contradictoryOwnerCount).toBe(0)
  })

  it('isolates grouped repos by an explicit folder SSH owner', () => {
    const scope = resolveDirectSshTargetScope({
      ...baseInput,
      repos: [
        {
          id: 'shared-repo',
          path: '/local/project/repo',
          projectGroupId: 'shared-group',
          connectionId: null,
          executionHostId: 'local'
        },
        {
          id: 'shared-repo',
          path: '/srv/project/repo',
          projectGroupId: 'shared-group',
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      projectGroups: [
        {
          id: 'shared-group',
          parentGroupId: null,
          connectionId: null,
          executionHostId: 'local'
        },
        {
          id: 'shared-group',
          parentGroupId: null,
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      folderWorkspaces: [
        {
          id: 'remote-folder',
          projectGroupId: 'shared-group',
          folderPath: '/srv/project',
          connectionId: 'target-a'
        }
      ]
    })

    expect(scope.terminalWorkspaceKeys).toEqual(new Set(['folder:remote-folder']))
    expect(scope.ambiguousOwnerCount).toBe(0)
    expect(scope.contradictoryOwnerCount).toBe(0)
  })

  it('lets an omitted folder connection inherit one SSH group owner', () => {
    const scope = resolveDirectSshTargetScope({
      ...baseInput,
      repos: [],
      projectGroups: [
        {
          id: 'remote-group',
          parentGroupId: null,
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      folderWorkspaces: [
        {
          id: 'remote-folder',
          projectGroupId: 'remote-group',
          folderPath: '/srv/project'
        }
      ]
    })

    expect(scope.terminalWorkspaceKeys).toEqual(new Set(['folder:remote-folder']))
  })

  it('fails closed when an omitted folder connection has conflicting group owners', () => {
    const scope = resolveDirectSshTargetScope({
      ...baseInput,
      repos: [],
      projectGroups: [
        {
          id: 'shared-group',
          parentGroupId: null,
          connectionId: null,
          executionHostId: 'local'
        },
        {
          id: 'shared-group',
          parentGroupId: null,
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      folderWorkspaces: [
        {
          id: 'ambiguous-folder',
          projectGroupId: 'shared-group',
          folderPath: '/srv/project'
        }
      ]
    })

    expect(scope.terminalWorkspaceKeys.size).toBe(0)
    expect(scope.ambiguousOwnerCount).toBe(1)
  })

  it('keeps runtime-owned SSH work isolated from the direct target', () => {
    const scope = resolveDirectSshTargetScope({
      ...baseInput,
      repos: [
        {
          id: 'runtime-ssh',
          path: '/runtime/repo',
          projectGroupId: null,
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      worktreesByRepo: {
        'runtime-ssh': [
          {
            id: 'runtime-ssh::worktree',
            repoId: 'runtime-ssh',
            hostId: 'ssh:target-a',
            runtimeOwnerEnvironmentId: 'hub-a'
          }
        ]
      }
    })

    expect(scope.gitWorktreeIds.size).toBe(0)
    expect(scope.terminalWorkspaceKeys.size).toBe(0)
    expect(scope.contradictoryOwnerCount).toBe(1)
  })

  it('rejects explicit worktree and exact repo ownership contradictions', () => {
    const scope = resolveDirectSshTargetScope({
      ...baseInput,
      repos: [
        {
          id: 'repo',
          path: '/target-a/repo',
          projectGroupId: null,
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      worktreesByRepo: {
        repo: [{ id: 'repo::wrong-host', repoId: 'repo', hostId: 'ssh:target-b' }]
      }
    })

    expect(scope.gitRepos).toEqual([{ repoId: 'repo', executionHostId: 'ssh:target-a' }])
    expect(scope.gitWorktreeIds.size).toBe(0)
    expect(scope.contradictoryOwnerCount).toBe(1)
  })

  it('excludes ambiguous legacy and duplicate same-host folder owners', () => {
    const scope = resolveDirectSshTargetScope({
      ...baseInput,
      repos: [],
      worktreesByRepo: {
        legacy: [{ id: 'legacy::worktree', repoId: 'legacy' }],
        unresolved: [
          {
            id: 'unresolved::worktree',
            repoId: 'unresolved',
            hostId: 'runtime:unresolved-owner'
          }
        ]
      },
      projectGroups: [
        {
          id: 'group',
          parentGroupId: null,
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      folderWorkspaces: [
        {
          id: 'duplicate-folder',
          projectGroupId: 'group',
          folderPath: '/srv/project',
          connectionId: 'target-a'
        },
        {
          id: 'duplicate-folder',
          projectGroupId: 'group',
          folderPath: '/srv/project',
          connectionId: 'target-a'
        }
      ]
    })

    expect(scope.gitWorktreeIds.size).toBe(0)
    expect(scope.terminalWorkspaceKeys.size).toBe(0)
    expect(scope.ambiguousOwnerCount).toBe(3)
    expect(scope.contradictoryOwnerCount).toBe(0)
  })

  it('rejects conflicting folder workspace, group, repo, and restored provenance', () => {
    const scope = resolveDirectSshTargetScope({
      ...baseInput,
      repos: [
        {
          id: 'repo-b',
          path: '/srv/project/repo',
          projectGroupId: 'group',
          connectionId: 'target-b',
          executionHostId: 'ssh:target-b'
        }
      ],
      projectGroups: [
        {
          id: 'group',
          parentGroupId: null,
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      folderWorkspaces: [
        {
          id: 'mixed-folder',
          projectGroupId: 'group',
          folderPath: '/srv/project',
          connectionId: 'target-a'
        }
      ],
      restoredRuntimeHostIdByWorkspaceSessionKey: {
        'folder:mixed-folder': 'runtime:hub-a'
      }
    })

    expect(scope.terminalWorkspaceKeys.size).toBe(0)
    expect(scope.contradictoryOwnerCount).toBe(1)
  })

  it('treats explicit folder null as local despite a stale SSH group host stamp', () => {
    const scope = resolveDirectSshTargetScope({
      ...baseInput,
      repos: [],
      projectGroups: [
        {
          id: 'legacy-group',
          parentGroupId: null,
          connectionId: null,
          executionHostId: 'ssh:target-a'
        }
      ],
      folderWorkspaces: [
        {
          id: 'legacy-folder',
          projectGroupId: 'legacy-group',
          folderPath: '/srv/legacy',
          connectionId: null
        }
      ]
    })

    expect(scope.terminalWorkspaceKeys.size).toBe(0)
    expect(scope.ambiguousOwnerCount).toBe(0)
  })
})
