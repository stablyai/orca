import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { resolveDirectSshTerminalWorkspaceKeys } from './direct-ssh-terminal-workspace-scope'

function tab(worktreeId: string, ptyId: string): TerminalTab {
  return {
    id: `tab-${worktreeId}`,
    worktreeId,
    ptyId,
    title: worktreeId,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('resolveDirectSshTerminalWorkspaceKeys', () => {
  it('uses a parsed live target PTY when the catalog row is stale', () => {
    expect(
      resolveDirectSshTerminalWorkspaceKeys(
        { targetId: 'target-a', catalogRevision: 1, repos: [] },
        { 'stale-worktree': [tab('stale-worktree', 'ssh:target-a@@pty-1')] }
      )
    ).toEqual(new Set(['stale-worktree']))
  })

  it('uses a retained target PTY after disconnect clears the live binding', () => {
    expect(
      resolveDirectSshTerminalWorkspaceKeys(
        { targetId: 'target-a', catalogRevision: 1, repos: [] },
        { 'stale-worktree': [tab('stale-worktree', '')] },
        { 'tab-stale-worktree': 'ssh:target-a@@pty-1' }
      )
    ).toEqual(new Set(['stale-worktree']))
  })

  it('refuses retained PTY fallback when explicit ownership names another host', () => {
    expect(
      resolveDirectSshTerminalWorkspaceKeys(
        {
          targetId: 'target-a',
          catalogRevision: 1,
          repos: [],
          worktreesByRepo: {
            repo: [
              {
                id: 'contradictory-worktree',
                repoId: 'repo',
                hostId: 'ssh:target-b'
              }
            ]
          }
        },
        { 'contradictory-worktree': [tab('contradictory-worktree', '')] },
        { 'tab-contradictory-worktree': 'ssh:target-a@@pty-1' }
      )
    ).toEqual(new Set())
  })

  it('refuses retained PTY fallback when a repo id is owned by two SSH hosts', () => {
    expect(
      resolveDirectSshTerminalWorkspaceKeys(
        {
          targetId: 'target-a',
          catalogRevision: 1,
          repos: [
            {
              id: 'shared',
              path: '/srv/a/shared',
              projectGroupId: null,
              connectionId: 'target-a',
              executionHostId: 'ssh:target-a'
            },
            {
              id: 'shared',
              path: '/srv/b/shared',
              projectGroupId: null,
              connectionId: 'target-b',
              executionHostId: 'ssh:target-b'
            }
          ],
          worktreesByRepo: {
            shared: [{ id: 'shared::/work', repoId: 'shared' }]
          }
        },
        { 'shared::/work': [tab('shared::/work', '')] },
        { 'tab-shared::/work': 'ssh:target-a@@pty-retained' }
      )
    ).toEqual(new Set())
  })

  it('refuses a retained target when the current PTY names another SSH host', () => {
    expect(
      resolveDirectSshTerminalWorkspaceKeys(
        { targetId: 'target-a', catalogRevision: 1, repos: [] },
        {
          'stale-worktree': [
            tab('stale-worktree', 'ssh:target-b@@pty-live'),
            tab('stale-worktree', '')
          ]
        },
        { 'tab-stale-worktree': 'ssh:target-a@@pty-retained' }
      )
    ).toEqual(new Set())
  })

  it('refuses parsed PTY fallback when explicit worktree ownership names another host', () => {
    expect(
      resolveDirectSshTerminalWorkspaceKeys(
        {
          targetId: 'target-a',
          catalogRevision: 1,
          repos: [],
          worktreesByRepo: {
            repo: [
              {
                id: 'contradictory-worktree',
                repoId: 'repo',
                hostId: 'ssh:target-b'
              }
            ]
          }
        },
        {
          'contradictory-worktree': [tab('contradictory-worktree', 'ssh:target-a@@pty-1')]
        }
      )
    ).toEqual(new Set())
  })

  it('refuses parsed PTY fallback when explicit host provenance is malformed', () => {
    expect(
      resolveDirectSshTerminalWorkspaceKeys(
        {
          targetId: 'target-a',
          catalogRevision: 1,
          repos: [],
          worktreesByRepo: {
            repo: [
              {
                id: 'malformed-worktree',
                repoId: 'repo',
                hostId: 'ssh:%'
              }
            ]
          }
        },
        {
          'malformed-worktree': [tab('malformed-worktree', 'ssh:target-a@@pty-1')]
        }
      )
    ).toEqual(new Set())
  })

  it('refuses folder PTY fallback when project host provenance is malformed', () => {
    expect(
      resolveDirectSshTerminalWorkspaceKeys(
        {
          targetId: 'target-a',
          catalogRevision: 1,
          repos: [],
          folderWorkspaces: [
            {
              id: 'folder-a',
              projectGroupId: 'group-a',
              folderPath: '/srv/project',
              connectionId: 'target-a'
            }
          ],
          projectGroups: [
            {
              id: 'group-a',
              parentGroupId: null,
              connectionId: 'target-a',
              executionHostId: 'ssh:%'
            }
          ]
        },
        {
          'folder:folder-a': [tab('folder:folder-a', 'ssh:target-a@@pty-1')]
        }
      )
    ).toEqual(new Set())
  })

  it('refuses fallback when explicit worktree and repo-derived ownership disagree', () => {
    expect(
      resolveDirectSshTerminalWorkspaceKeys(
        {
          targetId: 'target-a',
          catalogRevision: 1,
          repos: [
            {
              id: 'repo',
              path: '/srv/repo',
              projectGroupId: null,
              connectionId: 'target-b',
              executionHostId: 'ssh:target-b'
            }
          ],
          worktreesByRepo: {
            repo: [
              {
                id: 'contradictory-worktree',
                repoId: 'repo',
                hostId: 'ssh:target-a'
              }
            ]
          }
        },
        {
          'contradictory-worktree': [tab('contradictory-worktree', 'ssh:target-a@@pty-1')]
        }
      )
    ).toEqual(new Set())
  })

  it('refuses runtime-owned and contradictory folder provenance', () => {
    const keys = resolveDirectSshTerminalWorkspaceKeys(
      {
        targetId: 'target-a',
        catalogRevision: 1,
        repos: [],
        worktreesByRepo: {
          repo: [
            {
              id: 'runtime-worktree',
              repoId: 'repo',
              hostId: 'ssh:target-a',
              runtimeOwnerEnvironmentId: 'runtime-1'
            }
          ]
        },
        folderWorkspaces: [
          {
            id: 'folder-b',
            projectGroupId: 'group-b',
            folderPath: '/srv/project',
            connectionId: 'target-b'
          }
        ],
        projectGroups: [
          {
            id: 'group-b',
            parentGroupId: null,
            connectionId: 'target-b',
            executionHostId: 'ssh:target-b'
          }
        ]
      },
      {
        'runtime-worktree': [tab('runtime-worktree', 'ssh:target-a@@pty-1')],
        'folder:folder-b': [tab('folder:folder-b', 'ssh:target-a@@pty-2')]
      }
    )

    expect(keys).toEqual(new Set())
  })
})
