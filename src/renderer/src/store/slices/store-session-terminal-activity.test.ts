import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree, makeTab } from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreSessionMockApi()

describe('terminal slice behaviors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves tabs omitted from a reorder request instead of dropping them', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    store.setState({
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({ id: 'tab-a', worktreeId, sortOrder: 0, createdAt: 1 }),
          makeTab({ id: 'tab-b', worktreeId, sortOrder: 1, createdAt: 2 }),
          makeTab({ id: 'tab-c', worktreeId, sortOrder: 2, createdAt: 3 })
        ]
      }
    })

    store.getState().reorderTabs(worktreeId, ['tab-c', 'tab-a'])

    expect(store.getState().tabsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({ id: 'tab-c', sortOrder: 0 }),
      expect.objectContaining({ id: 'tab-a', sortOrder: 1 }),
      expect.objectContaining({ id: 'tab-b', sortOrder: 2 })
    ])
  })

  it('falls back to the previous PTY id when clearing the active pane PTY', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1', hostId: 'local' })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: 'pty-2' })]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1', 'pty-2']
      }
    })

    store.getState().clearTabPtyId('tab-1', 'pty-2')

    const tab = store.getState().tabsByWorktree[worktreeId][0]
    expect(tab.ptyId).toBe('pty-1')
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual(['pty-1'])
  })

  it('keeps the original tab-level PTY when a split pane adds another PTY', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1', hostId: 'local' })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      }
    })

    store.getState().updateTabPtyId('tab-1', 'pty-2')

    const tab = store.getState().tabsByWorktree[worktreeId][0]
    expect(tab.ptyId).toBe('pty-1')
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual(['pty-1', 'pty-2'])
  })

  it('preserves unrelated worktree tab arrays when recording a spawned PTY', () => {
    const store = createTestStore()
    const targetWorktreeId = 'repo1::/path/wt1'
    const otherWorktreeId = 'repo1::/path/wt2'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: targetWorktreeId,
            repoId: 'repo1',
            path: '/path/wt1',
            hostId: 'local'
          }),
          makeWorktree({
            id: otherWorktreeId,
            repoId: 'repo1',
            path: '/path/wt2',
            hostId: 'local'
          })
        ]
      },
      tabsByWorktree: {
        [targetWorktreeId]: [makeTab({ id: 'tab-1', worktreeId: targetWorktreeId })],
        [otherWorktreeId]: [makeTab({ id: 'tab-2', worktreeId: otherWorktreeId })]
      }
    })

    const before = store.getState().tabsByWorktree
    const beforeOtherTabs = before[otherWorktreeId]

    store.getState().updateTabPtyId('tab-1', 'pty-fresh')

    const after = store.getState().tabsByWorktree
    expect(after[targetWorktreeId]).not.toBe(before[targetWorktreeId])
    expect(after[otherWorktreeId]).toBe(beforeOtherTabs)
  })

  it('does not persist worktree activity when attaching a mirrored remote runtime PTY', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1', lastActivityAt: 1000 })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId })]
      }
    })

    store.getState().updateTabPtyId('tab-1', 'remote:web-env@@terminal-1')

    expect(store.getState().worktreesByRepo.repo1[0].lastActivityAt).toBe(1000)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('preserves unrelated worktree tab arrays when clearing a PTY', () => {
    const store = createTestStore()
    const targetWorktreeId = 'repo1::/path/wt1'
    const otherWorktreeId = 'repo1::/path/wt2'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: targetWorktreeId,
            repoId: 'repo1',
            path: '/path/wt1',
            hostId: 'local'
          }),
          makeWorktree({
            id: otherWorktreeId,
            repoId: 'repo1',
            path: '/path/wt2',
            hostId: 'local'
          })
        ]
      },
      tabsByWorktree: {
        [targetWorktreeId]: [
          makeTab({ id: 'tab-1', worktreeId: targetWorktreeId, ptyId: 'pty-fresh' })
        ],
        [otherWorktreeId]: [makeTab({ id: 'tab-2', worktreeId: otherWorktreeId })]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-fresh']
      }
    })

    const before = store.getState().tabsByWorktree
    const beforeOtherTabs = before[otherWorktreeId]

    store.getState().clearTabPtyId('tab-1', 'pty-fresh')

    const after = store.getState().tabsByWorktree
    expect(after[targetWorktreeId]).not.toBe(before[targetWorktreeId])
    expect(after[otherWorktreeId]).toBe(beforeOtherTabs)
  })

  it('changes only the owning worktree tab array when recording a PTY in a large session', () => {
    const store = createTestStore()
    const worktreeCount = 125
    const targetIndex = 73
    const worktrees = Array.from({ length: worktreeCount }, (_, index) =>
      makeWorktree({
        id: `repo1::/path/wt-${index}`,
        repoId: 'repo1',
        path: `/path/wt-${index}`,
        hostId: 'local'
      })
    )
    const tabsByWorktree = Object.fromEntries(
      worktrees.map((worktree, index) => [
        worktree.id,
        [makeTab({ id: `tab-${index}`, worktreeId: worktree.id })]
      ])
    )

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: worktrees },
      tabsByWorktree
    })

    const targetTabId = `tab-${targetIndex}`
    const before = store.getState().tabsByWorktree

    store.getState().updateTabPtyId(targetTabId, 'pty-fresh')

    const after = store.getState().tabsByWorktree
    const changedWorktreeIds = Object.keys(after).filter(
      (worktreeId) => after[worktreeId] !== before[worktreeId]
    )
    expect(changedWorktreeIds).toEqual([`repo1::/path/wt-${targetIndex}`])
  })

  it('does not persist worktree activity when clearing a mirrored remote runtime PTY', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1', lastActivityAt: 1000 })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({
            id: 'tab-1',
            worktreeId,
            ptyId: 'remote:web-env@@terminal-1'
          })
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:web-env@@terminal-1']
      }
    })

    store.getState().clearTabPtyId('tab-1', 'remote:web-env@@terminal-1')

    expect(store.getState().worktreesByRepo.repo1[0].lastActivityAt).toBe(1000)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  // Why: a click's fresh spawn on dead-PTY tabs would bump activity and float the worktree up Recent; pendingActivationSpawn prevents it (PR 310e9daf).
  it('does not bump lastActivityAt when a click-driven fresh spawn follows setActiveWorktree', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const originalLastActivityAt = 1000

    // Why: a null-ptyId tab hits setActiveWorktree's allDead branch, which tags pendingActivationSpawn to suppress the fresh spawn.
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/path/wt1',
            lastActivityAt: originalLastActivityAt
          })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: null })]
      },
      ptyIdsByTabId: { 'tab-1': [] },
      unifiedTabsByWorktree: {
        [worktreeId]: [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId: 'group-1',
            worktreeId,
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      groupsByWorktree: {
        [worktreeId]: [{ id: 'group-1', worktreeId, activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'group-1' }
    })

    store.getState().setActiveWorktree(worktreeId)
    // The allDead generation bump tagged the tab with pendingActivationSpawn.
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBe(true)

    // Simulate the fresh spawn coming back from TerminalPane's remount.
    store.getState().updateTabPtyId('tab-1', 'pty-fresh')

    const worktree = store.getState().worktreesByRepo.repo1[0]
    expect(worktree.lastActivityAt).toBe(originalLastActivityAt)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalledWith(
      expect.objectContaining({
        updates: expect.objectContaining({ lastActivityAt: expect.any(Number) })
      })
    )
    // The flag is consumed so a later legit respawn (codex restart etc.) isn't silently suppressed too.
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBeUndefined()
  })

  it('bumps activation generation for slept wake-hint tabs with no live PTY', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({
            id: 'tab-1',
            worktreeId,
            ptyId: 'wake-hint-session',
            generation: 2
          })
        ]
      },
      ptyIdsByTabId: { 'tab-1': [] },
      unifiedTabsByWorktree: {
        [worktreeId]: [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId: 'group-1',
            worktreeId,
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      groupsByWorktree: {
        [worktreeId]: [{ id: 'group-1', worktreeId, activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'group-1' }
    })

    store.getState().setActiveWorktree(worktreeId)

    const tab = store.getState().tabsByWorktree[worktreeId][0]
    expect(tab.generation).toBe(3)
    expect(tab.pendingActivationSpawn).toBe(true)
  })

  // Why: first activation tags every tab (even live-looking ptyIds, since reconnect may repopulate before mount); re-activation must not re-tag or it drops later spawns.
  it('tags on first activation but not on re-activation', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: 'pty-restored' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-restored'] },
      unifiedTabsByWorktree: {
        [worktreeId]: [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId: 'group-1',
            worktreeId,
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      groupsByWorktree: {
        [worktreeId]: [{ id: 'group-1', worktreeId, activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'group-1' }
    })

    // First activation: tabs get tagged even though tab.ptyId is non-null.
    store.getState().setActiveWorktree(worktreeId)
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBe(true)

    // updateTabPtyId from the pane mount consumes the tag.
    store.getState().updateTabPtyId('tab-1', 'pty-live')
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBeUndefined()

    // Switch away, then re-activate: re-activation must NOT tag again, or a later legit spawn (codex restart, new pane) is dropped.
    store.getState().setActiveWorktree(null)
    store.getState().setActiveWorktree(worktreeId)
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBeUndefined()
  })

  // Why: re-activating dead-PTY worktrees triggers the allDead respawn (a click side-effect, not activity) that first-activation tagging misses, so tag it too.
  it('does not bump lastActivityAt when a re-activation respawns dead PTYs', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const originalLastActivityAt = 1000

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/path/wt1',
            lastActivityAt: originalLastActivityAt
          })
        ]
      },
      // Wake-hint ptyId but no live PTY, and worktree already activated this session — a re-activation, not a first activation.
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: 'wake-hint-session' })]
      },
      ptyIdsByTabId: { 'tab-1': [] },
      everActivatedWorktreeIds: new Set([worktreeId]),
      unifiedTabsByWorktree: {
        [worktreeId]: [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId: 'group-1',
            worktreeId,
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      groupsByWorktree: {
        [worktreeId]: [{ id: 'group-1', worktreeId, activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'group-1' }
    })

    store.getState().setActiveWorktree(worktreeId)
    // The allDead generation bump must tag the tab so the click-driven respawn is suppressed, even on a non-first activation.
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBe(true)

    const sortEpochBeforeSpawn = store.getState().sortEpoch

    // Stale wake-hint reattach fails before a fresh spawn; the clear suppresses its own bump without consuming the spawn suppression.
    store.getState().clearTabPtyId('tab-1', 'wake-hint-session')
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBe(true)

    // Simulate the fresh spawn coming back from TerminalPane's remount.
    store.getState().updateTabPtyId('tab-1', 'pty-fresh')

    const worktree = store.getState().worktreesByRepo.repo1[0]
    expect(worktree.lastActivityAt).toBe(originalLastActivityAt)
    expect(store.getState().sortEpoch).toBe(sortEpochBeforeSpawn)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalledWith(
      expect.objectContaining({
        updates: expect.objectContaining({ lastActivityAt: expect.any(Number) })
      })
    )
    // The flag is consumed so a later legitimate respawn still bumps.
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBeUndefined()
  })

  it('suppresses every pane spawn from a click-driven split-layout remount', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const originalLastActivityAt = 1000

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/path/wt1',
            lastActivityAt: originalLastActivityAt
          })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: null })]
      },
      ptyIdsByTabId: { 'tab-1': [] },
      everActivatedWorktreeIds: new Set([worktreeId]),
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf-1' },
            second: { type: 'leaf', leafId: 'leaf-2' }
          },
          activeLeafId: 'leaf-1',
          expandedLeafId: null
        }
      },
      unifiedTabsByWorktree: {
        [worktreeId]: [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId: 'group-1',
            worktreeId,
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      groupsByWorktree: {
        [worktreeId]: [{ id: 'group-1', worktreeId, activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'group-1' }
    })

    store.getState().setActiveWorktree(worktreeId)
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBe(2)

    store.getState().updateTabPtyId('tab-1', 'pty-pane-1')
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBe(true)

    store.getState().updateTabPtyId('tab-1', 'pty-pane-2')

    const worktree = store.getState().worktreesByRepo.repo1[0]
    expect(worktree.lastActivityAt).toBe(originalLastActivityAt)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalledWith(
      expect.objectContaining({
        updates: expect.objectContaining({ lastActivityAt: expect.any(Number) })
      })
    )
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBeUndefined()
  })

  // Why: first-visit worktrees auto-create a pendingActivationSpawn tab so the spawn doesn't stamp lastActivityAt and bounce Recent.
  it('does not bump lastActivityAt when createTab auto-creates for a first-visit worktree', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const originalLastActivityAt = 1000

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/path/wt1',
            lastActivityAt: originalLastActivityAt
          })
        ]
      },
      // No tabs yet — a fresh worktree visited for the first time this session.
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      activeWorktreeId: worktreeId
    })

    // Simulate Terminal.tsx's auto-create effect: tag as activation-driven.
    const newTab = store
      .getState()
      .createTab(worktreeId, undefined, undefined, { pendingActivationSpawn: true })

    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBe(true)

    // PTY comes back from the newly-mounted TerminalPane.
    store.getState().updateTabPtyId(newTab.id, 'pty-fresh')

    const worktree = store.getState().worktreesByRepo.repo1[0]
    expect(worktree.lastActivityAt).toBe(originalLastActivityAt)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalledWith(
      expect.objectContaining({
        updates: expect.objectContaining({ lastActivityAt: expect.any(Number) })
      })
    )
    // Flag is consumed — later legitimate respawns still bump.
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBeUndefined()
  })

  // Why: real background events (agent output, OSC titles) must still bump activity; only activation-driven spawns are suppressed.
  it('bumps lastActivityAt for a fresh spawn with no activation tag', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/path/wt1',
            hostId: 'local',
            lastActivityAt: 1000
          })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: null })]
      }
    })

    store.getState().updateTabPtyId('tab-1', 'pty-fresh')

    const worktree = store.getState().worktreesByRepo.repo1[0]
    expect(worktree.lastActivityAt).toBeGreaterThan(1000)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId,
        updates: expect.objectContaining({ lastActivityAt: expect.any(Number) })
      })
    )
  })
})

// ─── Reconnect persisted terminals ──────────────────────────────────

// Mock pty-transport's eager buffer registration
