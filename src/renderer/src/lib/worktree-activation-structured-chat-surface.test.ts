import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import { queueStandaloneSetupTab } from './worktree-setup-issue-command-queue'
import {
  makeCreatedAgentWorktree as makeWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/worktree-activation-created-agent-test-state'
import {
  createMockStore,
  registerWorktreeActivationReset,
  setSetupScriptLaunchMode
} from './worktree-activation-test-harness'

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

describe('terminal seeding for explicit setup work', () => {
  it('runs a new-tab setup script without seeding a shell', () => {
    let createdIndex = 0
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({ createTab })

    const queued = queueStandaloneSetupTab({
      store,
      worktreeId: 'wt-1',
      setup,
      issueCommand: undefined,
      defaultTabs: undefined,
      opts: { activateCreatedTabs: false }
    })

    expect(queued).toBe(true)
    expect(createTab).toHaveBeenCalledTimes(1)
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-1', 'Setup', {
      recordInteraction: false
    })
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
      env: setup.envVars
    })
  })

  it('still seeds a shell when setup runs as a split', () => {
    let createdIndex = 0
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({ createTab })
    setSetupScriptLaunchMode('split-vertical')

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, setup)

    expect(createTab).toHaveBeenCalledTimes(1)
    expect(store.queueTabSetupSplit).toHaveBeenCalledWith('tab-1', expect.anything())
  })

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
      undefined
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

  it('activation creates a primary shell plus a new-tab setup surface', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)

    const result = activateAndRevealWorktree(worktree.id, {
      notifyHostRuntime: false,
      setup
    })

    expect(result).not.toBe(false)
    expect(result === false ? null : result.primaryTabId).toBeTruthy()
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toHaveLength(2)
  })
})
