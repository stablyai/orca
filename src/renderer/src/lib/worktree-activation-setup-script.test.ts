import { describe, expect, it, vi } from 'vitest'
import { SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV } from '../../../shared/setup-agent-sequencing'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import {
  createMockStore,
  registerWorktreeActivationReset,
  setLegacySetupScriptLaunchMode,
  createdTabStartups
} from './worktree-activation.test-fixture'

registerWorktreeActivationReset()

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
    expect(createdTabStartups(store)['tab-2']).toEqual({
      command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
      env: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
      }
    })
  })

  it('queues setup through returned POSIX shell metadata on native Windows paths', () => {
    let createdIndex = 0
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({ createTab })

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, {
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix' },
      envVars: {
        ORCA_ROOT_PATH: 'C:\\repo',
        ORCA_WORKTREE_PATH: 'C:\\worktrees\\wt-1'
      }
    })

    expect(createdTabStartups(store)['tab-2']).toEqual({
      command: 'bash /c/repo/.git/orca/setup-runner.sh',
      env: {
        ORCA_ROOT_PATH: 'C:\\repo',
        ORCA_WORKTREE_PATH: 'C:\\worktrees\\wt-1'
      }
    })
  })

  it('queues returned setup on an existing terminal tab when startup was already adopted', () => {
    let createdIndex = 1
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
      createTab,
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 1 }))
    })

    const result = ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, {
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      command: 'bash -lc wrapped-setup',
      envVars: { ORCA_ROOT_PATH: '/tmp/repo' }
    })

    expect(result).toBe('tab-1')
    expect(createTab).toHaveBeenCalledTimes(1)
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-2', 'Setup', {
      recordInteraction: false
    })
    expect(createdTabStartups(store)['tab-2']).toEqual({
      command: 'bash -lc wrapped-setup',
      env: { ORCA_ROOT_PATH: '/tmp/repo' }
    })
  })

  it('queues wrapped setup on an existing terminal tab when setup gates startup', () => {
    let createdIndex = 1
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
      createTab,
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
    expect(createdTabStartups(store)['tab-2']).toEqual(
      expect.objectContaining({
        command: expect.stringContaining('bash /tmp/repo/.git/orca/setup-runner.sh')
      })
    )
    expect(createdTabStartups(store)['tab-2']).toEqual(
      expect.objectContaining({
        command: expect.stringContaining('printf')
      })
    )
  })

  it('queues WSL setup launch commands with WSL path conversion on native Windows paths', () => {
    let createdIndex = 0
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({ createTab })

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, {
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix', executable: 'wsl.exe' },
      envVars: {
        ORCA_ROOT_PATH: 'C:\\repo',
        ORCA_WORKTREE_PATH: 'C:\\worktrees\\wt-1'
      }
    })

    expect(createdTabStartups(store)['tab-2']).toEqual({
      command: 'bash /mnt/c/repo/.git/orca/setup-runner.sh',
      env: {
        ORCA_ROOT_PATH: 'C:\\repo',
        ORCA_WORKTREE_PATH: 'C:\\worktrees\\wt-1'
      }
    })
  })

  it('gates startup behind setup completion when both are provided in new-tab mode', () => {
    setLegacySetupScriptLaunchMode('new-tab')
    let createdIndex = 0
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({ createTab })

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      { command: 'claude' },
      {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: { ORCA_ROOT_PATH: '/tmp/repo' },
        waitForAgentStartup: true
      }
    )

    expect(createdTabStartups(store)['tab-1']).toEqual(
      expect.objectContaining({
        env: expect.objectContaining({
          [SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]: expect.stringContaining(
            'Timed out waiting for setup before starting agent.'
          )
        })
      })
    )
    expect(createdTabStartups(store)['tab-1']).toEqual(
      expect.objectContaining({
        env: expect.objectContaining({
          [SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]: expect.stringContaining('exec claude')
        })
      })
    )
    expect(createdTabStartups(store)['tab-2']).toEqual(
      expect.objectContaining({
        command: expect.stringContaining('printf')
      })
    )
    expect(createdTabStartups(store)['tab-2']).toEqual(
      expect.objectContaining({
        command: expect.stringContaining('bash /tmp/repo/.git/orca/setup-runner.sh')
      })
    )
  })

  it('starts setup and agent side by side by default', () => {
    setLegacySetupScriptLaunchMode('new-tab')
    let createdIndex = 0
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({ createTab })

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      { command: 'claude' },
      {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: { ORCA_ROOT_PATH: '/tmp/repo' }
      }
    )

    expect(createdTabStartups(store)['tab-1']).toEqual({
      command: 'claude'
    })
    expect(createdTabStartups(store)['tab-2']).toEqual({
      command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
      env: { ORCA_ROOT_PATH: '/tmp/repo' }
    })
  })

  it('keeps setup sequencing after retiring a saved split preference', () => {
    setLegacySetupScriptLaunchMode('split-vertical')
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      { command: 'claude' },
      {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: { ORCA_ROOT_PATH: '/tmp/repo' },
        waitForAgentStartup: true
      }
    )

    expect(createdTabStartups(store)['tab-1']).toEqual(
      expect.objectContaining({
        env: expect.objectContaining({
          [SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]: expect.stringContaining('exec claude')
        })
      })
    )
    expect(createdTabStartups(store)['tab-2']).toEqual({
      command: expect.stringContaining('bash /tmp/repo/.git/orca/setup-runner.sh'),
      env: { ORCA_ROOT_PATH: '/tmp/repo' }
    })
    expect(createdTabStartups(store)['tab-2']).toEqual({
      command: expect.stringContaining('printf'),
      env: { ORCA_ROOT_PATH: '/tmp/repo' }
    })
  })

  it('keeps WSL setup shell metadata when gating startup behind setup completion', () => {
    setLegacySetupScriptLaunchMode('split-vertical')
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      { command: 'claude' },
      {
        runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.sh',
        shell: { family: 'posix', executable: 'wsl.exe' },
        envVars: { ORCA_ROOT_PATH: 'C:\\repo' },
        waitForAgentStartup: true
      }
    )

    expect(createdTabStartups(store)['tab-1']).toEqual(
      expect.objectContaining({
        env: expect.objectContaining({
          [SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]: expect.stringContaining(
            '/mnt/c/repo/.git/orca/setup-runner.sh'
          )
        })
      })
    )
    expect(createdTabStartups(store)['tab-2']).toEqual({
      command: expect.stringContaining('bash /mnt/c/repo/.git/orca/setup-runner.sh'),
      env: { ORCA_ROOT_PATH: 'C:\\repo' }
    })
  })

  it.each(['split-vertical', 'split-horizontal', 'new-tab', null] as const)(
    'creates a dedicated Setup tab for retired location %s',
    (mode) => {
      setLegacySetupScriptLaunchMode(mode)
      const store = createMockStore()
      ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: { ORCA_ROOT_PATH: '/tmp/repo' }
      })
      expect(store.createTab).toHaveBeenCalledTimes(2)
      expect(createdTabStartups(store)['tab-2']).toEqual({
        command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
        env: { ORCA_ROOT_PATH: '/tmp/repo' }
      })
      expect(store.setActiveTab).toHaveBeenLastCalledWith('tab-1')
      expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-2', 'Setup', {
        recordInteraction: false
      })
    }
  )

  it('creates a background Setup tab when setupScriptLaunchMode is new-tab', () => {
    setLegacySetupScriptLaunchMode('new-tab')
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
    expect(createdTabStartups(store)['tab-2']).toEqual({
      command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
      env: { ORCA_ROOT_PATH: '/tmp/repo' }
    })
  })
})
