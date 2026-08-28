import { describe, expect, it } from 'vitest'
import {
  exportRemoteWorkspaceSession,
  importRemoteWorkspaceSession
} from './remote-workspace-session-projection'
import { getDefaultWorkspaceSession } from './constants'

describe('remote workspace session projection', () => {
  it('exports terminal state using remote worktree paths instead of local repo ids', () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo-a',
      activeWorktreeId: 'repo-a::/srv/app',
      activeTabId: 'tab-1',
      tabsByWorktree: {
        'repo-a::/srv/app': [
          {
            id: 'tab-1',
            ptyId: 'pty-1',
            worktreeId: 'repo-a::/srv/app',
            title: 'Remote',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ],
        'repo-local::/tmp/local': [
          {
            id: 'tab-local',
            ptyId: 'pty-local',
            worktreeId: 'repo-local::/tmp/local',
            title: 'Local',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-1': { root: null, activeLeafId: null, expandedLeafId: null },
        'tab-local': { root: null, activeLeafId: null, expandedLeafId: null }
      },
      remoteSessionIdsByTabId: {
        'tab-1': 'pty-1',
        'tab-local': 'pty-local'
      },
      defaultTerminalTabsAppliedByWorktreeId: {
        'repo-a::/srv/app': true as const,
        'repo-local::/tmp/local': true as const
      }
    }

    const projected = exportRemoteWorkspaceSession(session, {
      isTargetWorktree: (worktreeId) => worktreeId.startsWith('repo-a::')
    })

    expect(Object.keys(projected.tabsByWorktreePath)).toEqual(['/srv/app'])
    expect(projected.tabsByWorktreePath['/srv/app'][0]).toMatchObject({
      id: 'tab-1',
      worktreePath: '/srv/app'
    })
    expect(projected.terminalLayoutsByTabId).toEqual({
      'tab-1': { root: null, activeLeafId: null, expandedLeafId: null }
    })
    expect(projected.remoteSessionIdsByTabId).toEqual({ 'tab-1': 'pty-1' })
    expect(projected.defaultTerminalTabsAppliedByWorktreePath).toEqual({ '/srv/app': true })
  })

  it('imports projected terminal state into this client repo id', () => {
    const session = importRemoteWorkspaceSession(
      {
        activeWorktreePath: '/srv/app',
        activeTabId: 'tab-1',
        tabsByWorktreePath: {
          '/srv/app': [
            {
              id: 'tab-1',
              ptyId: 'pty-1',
              worktreePath: '/srv/app',
              title: 'Remote',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'tab-1': { root: null, activeLeafId: null, expandedLeafId: null }
        },
        remoteSessionIdsByTabId: { 'tab-1': 'pty-1' },
        defaultTerminalTabsAppliedByWorktreePath: { '/srv/app': true }
      },
      { resolveWorktreeId: (path) => (path === '/srv/app' ? 'repo-b::/srv/app' : null) }
    )

    expect(session.activeRepoId).toBe('repo-b')
    expect(session.activeWorktreeId).toBe('repo-b::/srv/app')
    expect(session.tabsByWorktree['repo-b::/srv/app'][0]).toMatchObject({
      id: 'tab-1',
      worktreeId: 'repo-b::/srv/app'
    })
    expect(session.remoteSessionIdsByTabId).toEqual({ 'tab-1': 'pty-1' })
    expect(session.defaultTerminalTabsAppliedByWorktreeId).toEqual({
      'repo-b::/srv/app': true
    })
  })

  it('imports active worktree metadata even when the worktree has no terminal tabs', () => {
    const session = importRemoteWorkspaceSession(
      {
        activeWorktreePath: '/srv/app',
        activeTabId: null,
        tabsByWorktreePath: {},
        terminalLayoutsByTabId: {},
        activeTabIdByWorktreePath: { '/srv/app': null },
        lastVisitedAtByWorktreePath: { '/srv/app': 456 }
      },
      { resolveWorktreeId: (path) => (path === '/srv/app' ? 'repo-b::/srv/app' : null) }
    )

    expect(session.activeRepoId).toBe('repo-b')
    expect(session.activeWorktreeId).toBe('repo-b::/srv/app')
    expect(session.activeTabIdByWorktree).toEqual({ 'repo-b::/srv/app': null })
    expect(session.lastVisitedAtByWorktreeId).toEqual({ 'repo-b::/srv/app': 456 })
  })

  it('reports every host path whose terminal tabs could not be placed locally', () => {
    const unplaced: [string, number][] = []

    const session = importRemoteWorkspaceSession(
      {
        activeWorktreePath: '/srv/app',
        activeTabId: null,
        tabsByWorktreePath: {
          '/srv/app': [
            {
              id: 'tab-1',
              ptyId: 'pty-1',
              worktreePath: '/srv/app',
              title: 'Placed',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ],
          '/srv/gone': [
            {
              id: 'tab-2',
              ptyId: 'pty-2',
              worktreePath: '/srv/gone',
              title: 'Unplaced',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 2
            },
            {
              id: 'tab-3',
              ptyId: 'pty-3',
              worktreePath: '/srv/gone',
              title: 'Unplaced too',
              customTitle: null,
              color: null,
              sortOrder: 1,
              createdAt: 3
            }
          ],
          '/srv/also-gone': [
            {
              id: 'tab-4',
              ptyId: 'pty-4',
              worktreePath: '/srv/also-gone',
              title: 'Unplaced elsewhere',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 4
            }
          ],
          '/srv/empty-and-gone': []
        },
        terminalLayoutsByTabId: {}
      },
      {
        resolveWorktreeId: (path) => (path === '/srv/app' ? 'repo-b::/srv/app' : null),
        onUnplacedTerminalTabs: (worktreePath, tabCount) => unplaced.push([worktreePath, tabCount])
      }
    )

    // Once per unresolvable path that actually carried tabs: not the resolved path, and not the
    // path whose tab array was empty (nothing was lost there).
    expect(unplaced).toEqual([
      ['/srv/gone', 2],
      ['/srv/also-gone', 1]
    ])
    expect(Object.keys(session.tabsByWorktree)).toEqual(['repo-b::/srv/app'])
  })

  it('does not report unplaced tabs when every host path resolves', () => {
    const unplaced: string[] = []

    importRemoteWorkspaceSession(
      {
        activeWorktreePath: '/srv/app',
        activeTabId: 'tab-1',
        tabsByWorktreePath: {
          '/srv/app': [
            {
              id: 'tab-1',
              ptyId: 'pty-1',
              worktreePath: '/srv/app',
              title: 'Remote',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {}
      },
      {
        resolveWorktreeId: (path) => `repo-b::${path}`,
        onUnplacedTerminalTabs: (worktreePath) => unplaced.push(worktreePath)
      }
    )

    expect(unplaced).toEqual([])
  })
})
