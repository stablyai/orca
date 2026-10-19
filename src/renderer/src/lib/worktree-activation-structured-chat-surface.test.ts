import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import {
  makeCreatedAgentWorktree as makeWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/worktree-activation-created-agent.test-fixture'
import {
  createMockStore,
  registerWorktreeActivationReset,
  setLegacySetupScriptLaunchMode,
  createdTabStartups
} from './worktree-activation.test-fixture'

const initialAppStoreState = useAppStore.getState()

registerWorktreeActivationReset()

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialAppStoreState, true)
})

const setup = {
  runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
  envVars: { ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1' }
}

// Why: a native-chat create used to land the user on a bare "Terminal 1" beside the chat,
// because the returned setup script counted as work needing a shell to attach to.
describe('seeding beside a caller-provided chat surface', () => {
  it('runs a new-tab setup script without seeding a shell', () => {
    let createdIndex = 0
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({ createTab })

    const primaryTabId = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      setup,
      undefined,
      undefined,
      { callerProvidesSurface: true }
    )

    expect(primaryTabId).toBeNull()
    expect(createTab).toHaveBeenCalledTimes(1)
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-1', 'Setup', {
      recordInteraction: false
    })
    expect(createdTabStartups(store)['tab-1']).toEqual({
      command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
      env: setup.envVars
    })
  })

  it.each(['split-vertical', 'split-horizontal', 'new-tab', null] as const)(
    'ignores retired setup location %s beside a caller-provided chat',
    (mode) => {
      setLegacySetupScriptLaunchMode(mode)
      const store = createMockStore()
      const primary = ensureWorktreeHasInitialTerminal(
        store,
        'wt-1',
        undefined,
        setup,
        undefined,
        undefined,
        { callerProvidesSurface: true, activateCreatedTabs: false }
      )
      expect(primary).toBeNull()
      expect(store.createTab).toHaveBeenCalledExactlyOnceWith('wt-1', undefined, undefined, {
        recordInteraction: false,
        activate: false,
        pendingStartup: {
          command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
          env: setup.envVars
        }
      })
      expect(store.setActiveTab).not.toHaveBeenCalled()
      expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-1', 'Setup', {
        recordInteraction: false
      })
    }
  )

  it('still seeds a shell for issue automation, which splits from it', () => {
    let createdIndex = 0
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({ createTab })

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      undefined,
      { command: 'orca issue run' },
      undefined,
      { callerProvidesSurface: true }
    )

    expect(createTab).toHaveBeenCalledTimes(1)
    expect(store.queueTabIssueCommandSplit).toHaveBeenCalledWith('tab-1', {
      command: 'orca issue run',
      env: undefined
    })
  })

  it('still seeds a shell when the caller owns no surface', () => {
    let createdIndex = 0
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({ createTab })

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, setup)

    expect(createTab).toHaveBeenCalledTimes(2)
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-2', 'Setup', {
      recordInteraction: false
    })
  })

  it('activation forwards providesInitialSurface so setup alone adds one tab', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)

    const result = activateAndRevealWorktree(worktree.id, {
      providesInitialSurface: true,
      notifyHostRuntime: false,
      setup
    })

    expect(result).not.toBe(false)
    expect(result === false ? 'unused' : result.primaryTabId).toBeNull()
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toHaveLength(1)
  })
  it('does not enqueue setup again when its consumed tab is reactivated', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    activateAndRevealWorktree(worktree.id, {
      providesInitialSurface: true,
      notifyHostRuntime: false,
      setup
    })
    const state = useAppStore.getState()
    const setupTab = state.tabsByWorktree[worktree.id]?.[0]
    if (!setupTab) {
      throw new Error('missing Setup tab')
    }
    expect(state.consumeTabStartupCommand(setupTab.id)?.command).toContain('setup-runner.sh')
    activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toHaveLength(1)
    expect(useAppStore.getState().pendingStartupByTabId).toEqual({})
  })
})
