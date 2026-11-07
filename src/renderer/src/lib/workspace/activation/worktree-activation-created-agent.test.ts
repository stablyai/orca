import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../../shared/constants'
import { useAppStore } from '@/store/index'

import { activateAndRevealWorktree } from './worktree-activation'
import '../../web-runtime-worktree-terminal-after-wake'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import { resetWebRuntimeWakeTerminalRespawnForTests } from '@/runtime/hosted-terminals/restoration/web-runtime-wake-terminal-respawn'
import '@/runtime/web-session-tabs-sync/host-terminal-count-fixture'
import {
  makeCreatedAgentWorktree as makeWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/workspace/activation/worktree-activation-created-agent.test-fixture'
import '../../../runtime/rpc/testing/runtime-environment-bridge-fixture'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const initialAppStoreState = useAppStore.getState()

/** Activates and asserts a focusable tab appeared with no queued startup, returning its id. */

afterEach(() => {
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  vi.unstubAllGlobals()
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetWebRuntimeWakeTerminalRespawnForTests()
  useAppStore.setState(initialAppStoreState, true)
})

describe('activateAndRevealWorktree', () => {
  it('does not relaunch the creation-time agent when reopening an empty worktree', () => {
    const worktree = makeWorktree()
    const { revealWorktreeInSidebar } = seedEmptyActivatableWorktree(worktree)

    const result = activateAndRevealWorktree(worktree.id)
    const state = useAppStore.getState()
    const reopenedTab = state.tabsByWorktree[worktree.id]?.[0]

    // A focusable surface still appears — it is just a plain shell, with no queued agent launch.
    expect(result).toEqual({ primaryTabId: reopenedTab?.id })
    expect(reopenedTab).toBeDefined()
    expect(state.pendingStartupByTabId[reopenedTab!.id]).toBeUndefined()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith(worktree.id)
  })
})
