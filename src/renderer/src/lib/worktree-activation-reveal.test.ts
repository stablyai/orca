import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateAndRevealWorktree } from './worktree-activation'
import { registerWorktreeActivationReset } from './worktree-activation-test-harness'
import { useAppStore } from '@/store'
import { makeTab, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'

registerWorktreeActivationReset()

describe('activateAndRevealWorktree', () => {
  afterEach(() => {
    useAppStore.setState({
      activeRepoId: null,
      activeWorktreeId: null,
      activeView: 'terminal',
      filterRepoIds: [],
      isNavigatingHistory: false
    })
  })

  it('queues a one-shot initial cwd for the primary activation-created tab', () => {
    const queueTabInitialCwd = vi.fn()
    const revealWorktreeInSidebar = vi.fn()
    const worktree = makeWorktree({
      id: 'wt-1',
      repoId: 'repo-1',
      path: '/repo',
      displayName: 'main',
      branch: 'main',
      isMainWorktree: true
    })
    useAppStore.setState({
      activeRepoId: null,
      activeWorktreeId: null,
      activeView: 'settings',
      filterRepoIds: [],
      isNavigatingHistory: false,
      repos: [{ ...TEST_REPO, id: 'repo-1', connectionId: null }],
      worktreesByRepo: {
        'repo-1': [worktree]
      },
      getKnownWorktreeById: (worktreeId: string) => (worktreeId === 'wt-1' ? worktree : undefined),
      setActiveRepo: vi.fn(),
      setActiveView: vi.fn(),
      setActiveWorktree: vi.fn((worktreeId: string | null) => {
        useAppStore.setState({ activeWorktreeId: worktreeId })
        return true
      }),
      markWorktreeVisited: vi.fn(),
      recordWorktreeVisit: vi.fn(),
      reconcileWorktreeTabModel: vi.fn(() => ({
        renderableTabCount: 0,
        activeRenderableTabId: null
      })),
      createTab: vi.fn(() => {
        const tab = makeTab({ id: 'tab-1', worktreeId: 'wt-1' })
        const current = useAppStore.getState()
        useAppStore.setState({
          tabsByWorktree: { ...current.tabsByWorktree, 'wt-1': [tab] }
        })
        return tab
      }),
      setActiveTab: vi.fn(),
      setTabCustomTitle: vi.fn(),
      setTabColor: vi.fn(),
      markDefaultTerminalTabsApplied: vi.fn(),
      queueTabStartupCommand: vi.fn(),
      queueTabInitialCwd,
      queueTabSetupSplit: vi.fn(),
      queueTabIssueCommandSplit: vi.fn(),
      revealWorktreeInSidebar
    })

    const result = activateAndRevealWorktree('wt-1', {
      initialCwd: '/repo/packages/web'
    })

    expect(result).toEqual({ primaryTabId: 'tab-1' })
    expect(queueTabInitialCwd).toHaveBeenCalledWith('tab-1', '/repo/packages/web')
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-1')
  })
})
