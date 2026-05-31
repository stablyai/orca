/* eslint-disable max-lines -- Why: these activation cases share one mock store and assert ordering across startup, setup, issue commands, and default tabs. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SetupScriptLaunchMode } from '../../../shared/types'
import { ensureWorktreeHasInitialTerminal } from './worktree-activation'
import { useAppStore } from '@/store'

function setSetupScriptLaunchMode(mode: SetupScriptLaunchMode | null): void {
  useAppStore.setState((state) => ({
    settings: state.settings
      ? { ...state.settings, setupScriptLaunchMode: mode ?? 'new-tab' }
      : mode !== null
        ? ({ setupScriptLaunchMode: mode } as unknown as typeof state.settings)
        : state.settings
  }))
}

afterEach(() => {
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  useAppStore.setState((state) => ({
    settings: state.settings
      ? { ...state.settings, activeRuntimeEnvironmentId: null }
      : ({ activeRuntimeEnvironmentId: null } as unknown as typeof state.settings)
  }))
  setSetupScriptLaunchMode('new-tab')
})

function createMockStore(overrides: Record<string, unknown> = {}) {
  return {
    tabsByWorktree: {} as Record<string, { id: string }[]>,
    defaultTerminalTabsAppliedByWorktreeId: {} as Record<string, true>,
    createTab: vi.fn(() => ({ id: 'tab-1' })),
    setActiveTab: vi.fn(),
    setTabCustomTitle: vi.fn(),
    setTabColor: vi.fn(),
    markDefaultTerminalTabsApplied: vi.fn(),
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 })),
    queueTabStartupCommand: vi.fn(),
    queueTabSetupSplit: vi.fn(),
    queueTabIssueCommandSplit: vi.fn(),
    ...overrides
  }
}

describe('ensureWorktreeHasInitialTerminal', () => {
  it('creates a background Setup tab for newly created worktrees by default', () => {
    let createdIndex = 0
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({ createTab })

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, {
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
      }
    })

    expect(createTab).toHaveBeenCalledTimes(2)
    expect(store.setActiveTab).toHaveBeenNthCalledWith(1, 'tab-1')
    expect(store.setActiveTab).toHaveBeenLastCalledWith('tab-1')
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-2', 'Setup', {
      recordInteraction: false
    })
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-2', {
      command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
      env: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
      }
    })
    expect(store.queueTabSetupSplit).not.toHaveBeenCalled()
  })

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

  it('does not create a local fallback tab in the paired web runtime client', () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    useAppStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, activeRuntimeEnvironmentId: 'web-runtime-1' }
        : ({ activeRuntimeEnvironmentId: 'web-runtime-1' } as unknown as typeof state.settings)
    }))
    const store = createMockStore()

    const result = ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(result).toBeNull()
    expect(store.createTab).not.toHaveBeenCalled()
    expect(store.setActiveTab).not.toHaveBeenCalled()
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

  it('queues a startup command when agent launch is provided', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      { command: 'claude "Fix this bug"' },
      undefined,
      undefined
    )

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true
    })
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: 'claude "Fix this bug"'
    })
    expect(store.queueTabSetupSplit).not.toHaveBeenCalled()
    expect(store.queueTabIssueCommandSplit).not.toHaveBeenCalled()
  })

  it('forwards telemetry on the queued startup so main can fire agent_started', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      {
        command: 'claude',
        telemetry: {
          agent_kind: 'claude-code',
          launch_source: 'new_workspace_composer',
          request_kind: 'new'
        }
      },
      undefined,
      undefined
    )

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true,
      launchAgent: 'claude'
    })
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: 'claude',
      telemetry: {
        agent_kind: 'claude-code',
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      }
    })
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

  it('queues an issue command split when issueCommand is provided', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, undefined, {
      runnerScriptPath: '/tmp/repo/.git/orca/issue-command-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
      }
    })

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true
    })
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(store.queueTabSetupSplit).not.toHaveBeenCalled()
    expect(store.queueTabIssueCommandSplit).toHaveBeenCalledWith('tab-1', {
      command: 'bash /tmp/repo/.git/orca/issue-command-runner.sh',
      env: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
      }
    })
  })

  it('queues both setup split and issue command split when both are provided', () => {
    setSetupScriptLaunchMode('split-vertical')
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: { ORCA_ROOT_PATH: '/tmp/repo' }
      },
      {
        runnerScriptPath: '/tmp/repo/.git/orca/issue-command-runner.sh',
        envVars: { ORCA_ROOT_PATH: '/tmp/repo' }
      }
    )

    expect(store.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(store.queueTabSetupSplit).toHaveBeenCalledWith('tab-1', {
      command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
      env: { ORCA_ROOT_PATH: '/tmp/repo' },
      direction: 'vertical'
    })
    expect(store.queueTabIssueCommandSplit).toHaveBeenCalledWith('tab-1', {
      command: 'bash /tmp/repo/.git/orca/issue-command-runner.sh',
      env: { ORCA_ROOT_PATH: '/tmp/repo' }
    })
  })

  it('does not queue issue command split when issueCommand is not provided', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(store.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(store.queueTabIssueCommandSplit).not.toHaveBeenCalled()
  })

  it('queues a vertical setup split when setupScriptLaunchMode is split-vertical', () => {
    setSetupScriptLaunchMode('split-vertical')
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, {
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: { ORCA_ROOT_PATH: '/tmp/repo' }
    })

    expect(store.queueTabSetupSplit).toHaveBeenCalledWith('tab-1', {
      command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
      env: { ORCA_ROOT_PATH: '/tmp/repo' },
      direction: 'vertical'
    })
  })

  it('queues a horizontal setup split when setupScriptLaunchMode is split-horizontal', () => {
    setSetupScriptLaunchMode('split-horizontal')
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, {
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: { ORCA_ROOT_PATH: '/tmp/repo' }
    })

    expect(store.queueTabSetupSplit).toHaveBeenCalledWith('tab-1', {
      command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
      env: { ORCA_ROOT_PATH: '/tmp/repo' },
      direction: 'horizontal'
    })
  })

  it('creates a background Setup tab when setupScriptLaunchMode is new-tab', () => {
    setSetupScriptLaunchMode('new-tab')
    let createdIndex = 0
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({ createTab })

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, {
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: { ORCA_ROOT_PATH: '/tmp/repo' }
    })

    expect(createTab).toHaveBeenCalledTimes(2)
    // Main tab is activated first (new terminal), then setup tab is created,
    // and the helper re-activates the main tab so focus stays on tab-1.
    expect(store.setActiveTab).toHaveBeenNthCalledWith(1, 'tab-1')
    expect(store.setActiveTab).toHaveBeenLastCalledWith('tab-1')
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-2', 'Setup', {
      recordInteraction: false
    })
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-2', {
      command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
      env: { ORCA_ROOT_PATH: '/tmp/repo' }
    })
    expect(store.queueTabSetupSplit).not.toHaveBeenCalled()
  })
})
