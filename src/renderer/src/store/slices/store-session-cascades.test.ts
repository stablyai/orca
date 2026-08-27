import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree, makeTab, makeLayout } from './store-test-helpers'
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

describe('removeProject cascade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.repos.remove.mockResolvedValue(undefined)
    mockApi.pty.kill.mockResolvedValue(undefined)
  })

  it('cleans up all associated worktrees, tabs, ptys, and filter state', async () => {
    const store = createTestStore()
    const wt1 = 'repo1::/path/wt1'
    const wt2 = 'repo1::/path/wt2'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      activeRepoId: 'repo1',
      filterRepoIds: ['repo1'],
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: wt2, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      tabsByWorktree: {
        [wt1]: [makeTab({ id: 'tab1', worktreeId: wt1 })],
        [wt2]: [makeTab({ id: 'tab2', worktreeId: wt2 })]
      },
      ptyIdsByTabId: {
        tab1: ['pty1'],
        tab2: ['pty2']
      },
      suppressedPtyExitIds: { pty1: true, pty2: true },
      pendingCodexPaneRestartIds: { pty1: true, pty2: true },
      terminalLayoutsByTabId: {
        tab1: makeLayout(),
        tab2: makeLayout()
      },
      activeTabId: 'tab1'
    })

    await store.getState().removeProject('repo1')
    const s = store.getState()

    expect(s.repos).toEqual([])
    expect(s.activeRepoId).toBeNull()
    expect(s.filterRepoIds).not.toContain('repo1')
    expect(s.worktreesByRepo['repo1']).toBeUndefined()
    expect(s.tabsByWorktree[wt1]).toBeUndefined()
    expect(s.tabsByWorktree[wt2]).toBeUndefined()
    expect(s.ptyIdsByTabId['tab1']).toBeUndefined()
    expect(s.ptyIdsByTabId['tab2']).toBeUndefined()
    expect(s.terminalLayoutsByTabId['tab1']).toBeUndefined()
    expect(s.terminalLayoutsByTabId['tab2']).toBeUndefined()
    expect(s.activeTabId).toBeNull()

    // PTYs were killed
    expect(mockApi.pty.kill).toHaveBeenCalledWith('pty1')
    expect(mockApi.pty.kill).toHaveBeenCalledWith('pty2')

    // Tabs are gone before async exit events fire, so retaining one-shot guards would leak ephemeral PTY ids.
    expect(s.suppressedPtyExitIds['pty1']).toBeUndefined()
    expect(s.suppressedPtyExitIds['pty2']).toBeUndefined()
    expect(s.pendingCodexPaneRestartIds['pty1']).toBeUndefined()
    expect(s.pendingCodexPaneRestartIds['pty2']).toBeUndefined()

    store.getState().clearTabPtyId('tab1', 'pty1')
    store.getState().clearTabPtyId('tab2', 'pty2')

    // Why: exit IPC can arrive after repo purge but before the pane unmounts; a late exit must not recreate an index for an ownerless tab.
    expect(store.getState().ptyIdsByTabId['tab1']).toBeUndefined()
    expect(store.getState().ptyIdsByTabId['tab2']).toBeUndefined()
  })
})

describe('restartCodexTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('queues pane-scoped codex restarts without remounting the whole tab', () => {
    const store = createTestStore()
    const wt1 = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt1]: [makeTab({ id: 'tab1', worktreeId: wt1, title: 'codex', generation: 2 })]
      },
      ptyIdsByTabId: {
        tab1: ['pty-a', 'pty-b']
      },
      pendingStartupByTabId: {}
    })

    store.getState().queueCodexPaneRestarts(['pty-b'])
    const state = store.getState()

    expect(state.pendingCodexPaneRestartIds).toEqual({ 'pty-b': true })
    expect(state.pendingStartupByTabId).toEqual({})
    expect(state.suppressedPtyExitIds).toEqual({})
    expect(state.tabsByWorktree[wt1][0].generation).toBe(2)
  })
})
