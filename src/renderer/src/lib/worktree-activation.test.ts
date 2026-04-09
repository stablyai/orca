import { describe, expect, it, vi } from 'vitest'
import { ensureWorktreeHasInitialTerminal } from './worktree-activation'

function createMockStore(overrides: Record<string, unknown> = {}) {
  return {
    tabsByWorktree: {} as Record<string, { id: string }[]>,
    createTab: vi.fn(() => ({ id: 'tab-1' })),
    setActiveTab: vi.fn(),
    queueTabSetupSplit: vi.fn(),
    ...overrides
  }
}

describe('ensureWorktreeHasInitialTerminal', () => {
  it('creates a tab and queues a setup split for newly created worktrees', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1', {
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
      }
    })

    expect(store.createTab).toHaveBeenCalledWith('wt-1')
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(store.queueTabSetupSplit).toHaveBeenCalledWith('tab-1', {
      command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
      env: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
      }
    })
  })

  it('creates a single tab without setup split when no setup is provided', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(store.createTab).toHaveBeenCalledWith('wt-1')
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(store.queueTabSetupSplit).not.toHaveBeenCalled()
  })

  it('does not create or queue anything when the worktree already has tabs', () => {
    const store = createMockStore({
      tabsByWorktree: { 'wt-1': [{ id: 'tab-existing' }] }
    })

    ensureWorktreeHasInitialTerminal(store, 'wt-1', {
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {}
    })

    expect(store.createTab).not.toHaveBeenCalled()
    expect(store.setActiveTab).not.toHaveBeenCalled()
    expect(store.queueTabSetupSplit).not.toHaveBeenCalled()
  })
})
