import { describe, expect, it, vi } from 'vitest'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import type { AppStoreState } from './worktree-activation-test-harness'
import {
  createMockStore,
  registerWorktreeActivationReset
} from './worktree-activation-test-harness'
import { useAppStore } from '@/store'

registerWorktreeActivationReset()

describe('ensureWorktreeHasInitialTerminal', () => {
  it('does not create a local fallback tab in the paired web runtime client', () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    useAppStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, activeRuntimeEnvironmentId: 'web-runtime-1' }
        : ({ activeRuntimeEnvironmentId: 'web-runtime-1' } as unknown as typeof state.settings),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            hostId: 'local',
            runtimeOwnerEnvironmentId: 'web-runtime-1'
          }
        ] as never
      }
    }))
    const store = createMockStore()

    const result = ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(result).toBeNull()
    expect(store.createTab).not.toHaveBeenCalled()
    expect(store.setActiveTab).not.toHaveBeenCalled()
  })

  it('queues returned setup fallback on an existing web runtime tab', () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    useAppStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, activeRuntimeEnvironmentId: 'web-runtime-1' }
        : ({ activeRuntimeEnvironmentId: 'web-runtime-1' } as unknown as typeof state.settings),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            hostId: 'local',
            runtimeOwnerEnvironmentId: 'web-runtime-1'
          }
        ] as never
      }
    }))
    let createdIndex = 1
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
      createTab,
      settings: { activeRuntimeEnvironmentId: 'web-runtime-1' },
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 1 }))
    })

    const result = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      { command: 'claude' },
      {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: { ORCA_ROOT_PATH: '/tmp/repo' },
        waitForAgentStartup: true
      }
    )

    expect(result).toBe('tab-1')
    expect(createTab).toHaveBeenCalledTimes(1)
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-2', 'Setup', {
      recordInteraction: false
    })
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith(
      'tab-2',
      expect.objectContaining({
        command: expect.stringContaining('bash /tmp/repo/.git/orca/setup-runner.sh')
      })
    )
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith(
      'tab-2',
      expect.objectContaining({
        command: expect.stringContaining('printf')
      })
    )
  })

  it('holds the issue command for the first mirrored web runtime tab when none exists yet', () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    useAppStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, activeRuntimeEnvironmentId: 'web-runtime-1' }
        : ({ activeRuntimeEnvironmentId: 'web-runtime-1' } as unknown as typeof state.settings),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            hostId: 'local',
            runtimeOwnerEnvironmentId: 'web-runtime-1'
          }
        ] as never
      }
    }))
    useAppStore.setState({
      tabsByWorktree: {},
      getKnownWorktreeById: ((id: string) =>
        id === 'wt-1'
          ? { id: 'wt-1' }
          : undefined) as unknown as AppStoreState['getKnownWorktreeById']
    } as Partial<AppStoreState>)
    const store = createMockStore()

    const result = ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, undefined, {
      command: 'gh issue view 42'
    })

    // Why: runtime session tabs mirror in asynchronously — the command must be
    // held for the first mirrored tab rather than silently dropped.
    expect(result).toBeNull()
    expect(useAppStore.getState().pendingIssueCommandSplitByTabId).toEqual({})

    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [{ id: 'mirror-tab-1' }] }
    } as unknown as Partial<AppStoreState>)

    expect(useAppStore.getState().pendingIssueCommandSplitByTabId['mirror-tab-1']).toEqual({
      command: 'gh issue view 42'
    })
  })

  it('does not create a fallback while a backend startup terminal awaits mirroring', () => {
    useAppStore.setState({
      getKnownWorktreeById: ((id: string) =>
        id === 'wt-1'
          ? { id: 'wt-1' }
          : undefined) as unknown as AppStoreState['getKnownWorktreeById']
    } as Partial<AppStoreState>)
    const store = createMockStore()

    const result = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      undefined,
      { command: 'gh issue view 42' },
      undefined,
      { backendStartupTerminalSpawned: true }
    )

    expect(result).toBeNull()
    expect(store.createTab).not.toHaveBeenCalled()
    expect(store.setActiveTab).not.toHaveBeenCalled()

    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [{ id: 'mirror-tab-1' }] }
    } as unknown as Partial<AppStoreState>)

    expect(useAppStore.getState().pendingIssueCommandSplitByTabId['mirror-tab-1']).toEqual({
      command: 'gh issue view 42'
    })
  })

  it('creates a local initial terminal for explicitly local worktrees while a runtime is focused', () => {
    useAppStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, activeRuntimeEnvironmentId: 'web-runtime-1' }
        : ({ activeRuntimeEnvironmentId: 'web-runtime-1' } as unknown as typeof state.settings)
    }))
    const store = createMockStore({
      settings: { activeRuntimeEnvironmentId: 'web-runtime-1' },
      repos: [{ id: 'repo-1', executionHostId: 'local', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
    })

    const result = ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(result).toBe('tab-1')
    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true
    })
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
  })
})
