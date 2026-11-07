import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { activateAndRevealWorktree } from './worktree-activation'

import {
  makeCreatedAgentWorktree as makeWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/workspace/activation/worktree-activation-created-agent.test-fixture'
import { registerWorktreeActivationReset } from './worktree-activation.test-fixture'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

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

// Returned setup scripts must not force Terminal 1 beside a new native chat.
describe('seeding beside a caller-provided chat surface', () => {
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
