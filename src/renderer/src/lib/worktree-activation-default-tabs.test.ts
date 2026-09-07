import { describe, expect, it, vi } from 'vitest'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import {
  createMockStore,
  registerWorktreeActivationReset
} from './worktree-activation-test-harness'

registerWorktreeActivationReset()

describe('ensureWorktreeHasInitialTerminal', () => {
  it('creates a single tab without setup split when no setup is provided', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true
    })
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(store.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(store.queueTabSetupSplit).not.toHaveBeenCalled()
  })

  it('does not recreate a terminal after an explicit empty state was persisted', () => {
    const store = createMockStore({ tabsByWorktree: { 'wt-1': [] } })

    ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(store.createTab).not.toHaveBeenCalled()
    expect(store.setActiveTab).not.toHaveBeenCalled()
  })

  it('creates a terminal when explicit launch work targets an empty workspace', () => {
    const store = createMockStore({ tabsByWorktree: { 'wt-1': [] } })

    ensureWorktreeHasInitialTerminal(store, 'wt-1', { command: 'claude "Fix this bug"' })

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true
    })
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: 'claude "Fix this bug"'
    })
  })

  it('creates configured default tabs once with title, color, and opted-in commands', () => {
    let createdIndex = 0
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({ createTab })

    const result = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      undefined,
      undefined,
      {
        runCommands: true,
        tabs: [
          { title: 'Claude', color: '#f97316', command: 'claude' },
          { title: 'LocalHost', color: '#9ca3af', command: 'pnpm dev' }
        ]
      }
    )

    expect(result).toBe('tab-1')
    expect(store.markDefaultTerminalTabsApplied).toHaveBeenCalledWith('wt-1')
    expect(createTab).toHaveBeenCalledTimes(2)
    expect(createTab).toHaveBeenNthCalledWith(1, 'wt-1', undefined, undefined, {
      pendingActivationSpawn: true,
      recordInteraction: false
    })
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-1', 'Claude', {
      recordInteraction: false
    })
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-2', 'LocalHost', {
      recordInteraction: false
    })
    expect(store.setTabColor).toHaveBeenCalledWith('tab-1', '#f97316')
    expect(store.setTabColor).toHaveBeenCalledWith('tab-2', '#9ca3af')
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', { command: 'claude' })
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-2', { command: 'pnpm dev' })
    expect(store.setActiveTab).toHaveBeenLastCalledWith('tab-1')
  })

  it('can queue setup and default tabs without activating created tabs', () => {
    let createdIndex = 0
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({ createTab })

    const result = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: { ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1' }
      },
      undefined,
      {
        runCommands: true,
        tabs: [{ title: 'Dev', command: 'pnpm dev' }]
      },
      { activateCreatedTabs: false }
    )

    expect(result).toBe('tab-1')
    expect(createTab).toHaveBeenNthCalledWith(1, 'wt-1', undefined, undefined, {
      pendingActivationSpawn: true,
      recordInteraction: false,
      activate: false
    })
    expect(createTab).toHaveBeenNthCalledWith(2, 'wt-1', undefined, undefined, {
      recordInteraction: false,
      activate: false
    })
    expect(store.setActiveTab).not.toHaveBeenCalled()
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-2', 'Setup', {
      recordInteraction: false
    })
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', { command: 'pnpm dev' })
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-2', {
      command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
      env: { ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1' }
    })
  })

  it('does not run default tab commands when command execution is not approved', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, undefined, undefined, {
      runCommands: false,
      tabs: [{ title: 'Server', command: 'pnpm dev' }]
    })

    expect(store.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-1', 'Server', {
      recordInteraction: false
    })
  })

  it('does not duplicate default tabs after the worktree marker is persisted', () => {
    const store = createMockStore({
      defaultTerminalTabsAppliedByWorktreeId: { 'wt-1': true }
    })

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, undefined, undefined, {
      runCommands: true,
      tabs: [
        { title: 'Claude', command: 'claude' },
        { title: 'Server', command: 'pnpm dev' }
      ]
    })

    expect(store.createTab).toHaveBeenCalledTimes(1)
    expect(store.setTabCustomTitle).not.toHaveBeenCalledWith('tab-1', 'Claude', {
      recordInteraction: false
    })
    expect(store.queueTabStartupCommand).not.toHaveBeenCalledWith('tab-1', {
      command: 'claude'
    })
  })

  it('does not create or queue anything when the worktree already has renderable content', () => {
    const store = createMockStore({
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 1 }))
    })

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, {
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {}
    })

    expect(store.createTab).not.toHaveBeenCalled()
    expect(store.setActiveTab).not.toHaveBeenCalled()
    expect(store.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(store.queueTabSetupSplit).not.toHaveBeenCalled()
    expect(store.queueTabIssueCommandSplit).not.toHaveBeenCalled()
  })

  it('does not create a terminal just because the legacy terminal slice is empty', () => {
    const store = createMockStore({
      tabsByWorktree: { 'wt-1': [] },
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 2 }))
    })

    ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(store.createTab).not.toHaveBeenCalled()
    expect(store.setActiveTab).not.toHaveBeenCalled()
  })
})
