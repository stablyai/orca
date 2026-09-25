import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateAndRevealWorktree } from './worktree-activation'
import { registerWorktreeActivationReset } from './worktree-activation-test-harness'
import { useAppStore } from '@/store'

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
    useAppStore.setState({
      activeRepoId: null,
      activeWorktreeId: null,
      activeView: 'settings',
      filterRepoIds: [],
      isNavigatingHistory: false,
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            path: '/repo',
            displayName: 'main',
            branch: 'main',
            head: 'abc',
            isBare: false,
            isMainWorktree: true
          }
        ]
      },
      getKnownWorktreeById: (worktreeId: string) =>
        worktreeId === 'wt-1'
          ? ({
              id: 'wt-1',
              repoId: 'repo-1',
              path: '/repo',
              displayName: 'main',
              branch: 'main',
              head: 'abc',
              isBare: false,
              isMainWorktree: true
            } as never)
          : null,
      setActiveRepo: vi.fn(),
      setActiveView: vi.fn(),
      setActiveWorktree: vi.fn(),
      markWorktreeVisited: vi.fn(),
      recordWorktreeVisit: vi.fn(),
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 })),
      createTab: vi.fn(() => ({ id: 'tab-1' })),
      setActiveTab: vi.fn(),
      setTabCustomTitle: vi.fn(),
      setTabColor: vi.fn(),
      markDefaultTerminalTabsApplied: vi.fn(),
      queueTabStartupCommand: vi.fn(),
      queueTabInitialCwd,
      queueTabSetupSplit: vi.fn(),
      queueTabIssueCommandSplit: vi.fn(),
      revealWorktreeInSidebar
    } as never)

    const result = activateAndRevealWorktree('wt-1', {
      initialCwd: '/repo/packages/web',
      executionHostId: 'ssh:box'
    })

    expect(result).toEqual({ primaryTabId: 'tab-1' })
    expect(queueTabInitialCwd).toHaveBeenCalledWith('tab-1', '/repo/packages/web')
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-1', {
      executionHostId: 'ssh:box'
    })
  })

  it('reselects a live worktree without creating a second terminal tab', () => {
    const createTab = vi.fn(() => ({ id: 'tab-2' }))
    const existingTab = { id: 'tab-1' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies only the activation slice used by the test.
    useAppStore.setState({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      activeView: 'terminal',
      filterRepoIds: [],
      isNavigatingHistory: false,
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            path: '/repo',
            displayName: 'main',
            branch: 'main',
            head: 'abc',
            isBare: false,
            isMainWorktree: true
          }
        ]
      },
      tabsByWorktree: { 'wt-1': [existingTab] },
      getKnownWorktreeById: (worktreeId: string) =>
        worktreeId === 'wt-1'
          ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture omits unrelated worktree metadata.
            ({
              id: 'wt-1',
              repoId: 'repo-1',
              path: '/repo',
              displayName: 'main',
              branch: 'main',
              head: 'abc',
              isBare: false,
              isMainWorktree: true
            } as never)
          : null,
      setActiveRepo: vi.fn(),
      setActiveView: vi.fn(),
      setActiveWorktree: vi.fn(),
      markWorktreeVisited: vi.fn(),
      recordWorktreeVisit: vi.fn(),
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 1 })),
      createTab,
      setActiveTab: vi.fn(),
      setTabCustomTitle: vi.fn(),
      setTabColor: vi.fn(),
      markDefaultTerminalTabsApplied: vi.fn(),
      queueTabStartupCommand: vi.fn(),
      queueTabInitialCwd: vi.fn(),
      queueTabSetupSplit: vi.fn(),
      queueTabIssueCommandSplit: vi.fn(),
      revealWorktreeInSidebar: vi.fn()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies only the activation slice used by the test.
    } as never)

    const result = activateAndRevealWorktree('wt-1')

    expect(result).toEqual({ primaryTabId: null })
    expect(createTab).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toEqual([existingTab])
  })
})
