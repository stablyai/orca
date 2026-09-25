import { describe, expect, it } from 'vitest'
import {
  exportRemoteWorkspaceSession,
  importRemoteWorkspaceSession
} from './remote-workspace-session-projection'
import { getDefaultWorkspaceSession } from './constants'
import { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } from './terminal-scrollback-limits'

describe('remote workspace session projection', () => {
  // The transient set this boundary mirrors. `recovery` is the tab's in-flight
  // heal, timestamped with THIS machine's clock, and `pendingActivationSpawn` is
  // a one-shot mount handoff — neither means anything on another client's row,
  // and a foreign `startedAt` would be compared against the reader's Date.now().
  it('strips client-local transient tab fields on the way out', () => {
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
            createdAt: 1,
            pendingActivationSpawn: true,
            recovery: {
              attemptedAt: [1_000],
              generation: 1,
              outcome: 'failed' as const,
              startedAt: 1_000,
              reason: 'reattach-unverifiable' as const,
              tabGeneration: 1
            }
          }
        ]
      },
      terminalLayoutsByTabId: {}
    }

    const projected = exportRemoteWorkspaceSession(session, {
      isTargetWorktree: (worktreeId) => worktreeId.startsWith('repo-a::')
    })

    const exported = projected.tabsByWorktreePath['/srv/app'][0] as Record<string, unknown>
    expect(exported.recovery).toBeUndefined()
    expect(exported.pendingActivationSpawn).toBeUndefined()
    expect(exported.id).toBe('tab-1')
  })

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

  it('unions two local repo rows that collapse onto one host path instead of clobbering', () => {
    // Duplicate repo rows for one remote checkout are the normal state while a host catalog
    // reconciles. `worktreePathFromId` drops the repoId, so both keys project onto '/srv/app'; a
    // freshly created empty row iterating last used to publish an empty tab list for a workspace
    // the user had panes open in, and the upload is a wholesale replace-session (#15484).
    const session = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: 'repo-old::/srv/app',
      activeTabId: 'tab-live',
      tabsByWorktree: {
        'repo-old::/srv/app': [
          {
            id: 'tab-live',
            ptyId: 'pty-live',
            worktreeId: 'repo-old::/srv/app',
            title: 'Agent',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ],
        'repo-new::/srv/app': []
      },
      activeTabIdByWorktree: {
        'repo-old::/srv/app': 'tab-live',
        'repo-new::/srv/app': null
      },
      remoteSessionIdsByTabId: { 'tab-live': 'pty-live' }
    }

    const projected = exportRemoteWorkspaceSession(session, {
      isTargetWorktree: () => true
    })

    expect(
      projected.tabsByWorktreePath['/srv/app']?.map((tab) => tab.id),
      'the empty twin row erased a live pane from the host ledger'
    ).toEqual(['tab-live'])
    expect(projected.activeTabIdByWorktreePath?.['/srv/app']).toBe('tab-live')
    expect(projected.remoteSessionIdsByTabId).toEqual({ 'tab-live': 'pty-live' })
  })

  it('keeps one row per tab id when colliding local keys share a tab', () => {
    const tab = {
      id: 'tab-shared',
      ptyId: 'pty-shared',
      title: 'Agent',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        'repo-old::/srv/app': [{ ...tab, worktreeId: 'repo-old::/srv/app' }],
        'repo-new::/srv/app': [{ ...tab, worktreeId: 'repo-new::/srv/app' }]
      }
    }

    const projected = exportRemoteWorkspaceSession(session, { isTargetWorktree: () => true })

    expect(projected.tabsByWorktreePath['/srv/app']?.map((row) => row.id)).toEqual(['tab-shared'])
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

  // The upload-volume contract behind WorkspaceSessionState.localOnlyScrollbackByTabId: a
  // buffer in the shared layout rides the export whole; the same bytes in the local-only home
  // never leave the client. 20 tabs x 2 panes at the per-leaf cap is the shape that measured
  // ~22 MiB per replace-session when ordinary parks wrote the layout.
  describe('scrollback upload volume', () => {
    const TABS = 20
    const PANES = 2
    const worktreeId = 'repo-a::/srv/app'
    const leafBuffer = 'x'.repeat(TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT)

    function tabId(index: number): string {
      return `tab-${index}`
    }
    function leafId(tab: number, pane: number): string {
      return `${tabId(tab)}:leaf-${pane}`
    }
    function leafBuffers(tab: number): Record<string, string> {
      return Object.fromEntries(
        Array.from({ length: PANES }, (_, pane) => [leafId(tab, pane), leafBuffer])
      )
    }
    function sessionWith(home: 'shared' | 'localOnly' | 'none') {
      const tabs = Array.from({ length: TABS }, (_, index) => index)
      return {
        ...getDefaultWorkspaceSession(),
        activeRepoId: 'repo-a',
        activeWorktreeId: worktreeId,
        activeTabId: tabId(0),
        tabsByWorktree: {
          [worktreeId]: tabs.map((index) => ({
            id: tabId(index),
            ptyId: `pty-${index}`,
            worktreeId,
            title: `Remote ${index}`,
            customTitle: null,
            color: null,
            sortOrder: index,
            createdAt: 1
          }))
        },
        terminalLayoutsByTabId: Object.fromEntries(
          tabs.map((index) => [
            tabId(index),
            {
              root: {
                type: 'split' as const,
                direction: 'horizontal' as const,
                ratio: 0.5,
                first: { type: 'leaf' as const, leafId: leafId(index, 0) },
                second: { type: 'leaf' as const, leafId: leafId(index, 1) }
              },
              activeLeafId: leafId(index, 0),
              expandedLeafId: null,
              ptyIdsByLeafId: {
                [leafId(index, 0)]: `pty-${index}`,
                [leafId(index, 1)]: `pty-${index}b`
              },
              ...(home === 'shared' ? { buffersByLeafId: leafBuffers(index) } : {})
            }
          ])
        ),
        ...(home === 'localOnly'
          ? {
              localOnlyScrollbackByTabId: Object.fromEntries(
                tabs.map((index) => [tabId(index), leafBuffers(index)])
              )
            }
          : {})
      }
    }
    function exportedBytes(home: 'shared' | 'localOnly' | 'none'): number {
      const projected = exportRemoteWorkspaceSession(sessionWith(home), {
        isTargetWorktree: (id) => id === worktreeId
      })
      return Buffer.byteLength(JSON.stringify(projected))
    }

    it('ships a shared-layout capture whole, at roughly the raw byte count', () => {
      const shared = exportedBytes('shared')
      const rawBytes = TABS * PANES * TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT
      console.log(
        `[upload-volume] shared-layout capture: ${(shared / 1024 / 1024).toFixed(1)} MiB (raw ${(rawBytes / 1024 / 1024).toFixed(1)} MiB)`
      )
      expect(shared).toBeGreaterThan(rawBytes)
    })

    it('never ships the local-only home: the export stays at the bufferless baseline', () => {
      const baseline = exportedBytes('none')
      const localOnly = exportedBytes('localOnly')
      console.log(
        `[upload-volume] bufferless baseline: ${(baseline / 1024).toFixed(1)} KiB; local-only capture: ${(localOnly / 1024).toFixed(1)} KiB`
      )
      expect(localOnly).toBe(baseline)
      expect(
        JSON.stringify(
          exportRemoteWorkspaceSession(sessionWith('localOnly'), {
            isTargetWorktree: (id) => id === worktreeId
          })
        )
      ).not.toContain('localOnlyScrollbackByTabId')
    })
  })
})
