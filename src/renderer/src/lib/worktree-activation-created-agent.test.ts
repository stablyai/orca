import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../shared/constants'
import { useAppStore } from '@/store'
import { getWorktreeVisitTimestamp } from './worktree-visit-recency'
import { activateAndRevealWorktree } from './worktree-activation'
import './web-runtime-worktree-terminal-after-wake'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import { resetWebRuntimeWakeTerminalRespawnForTests } from '@/runtime/web-runtime-wake-terminal-respawn'
import '@/runtime/web-session-tabs-sync/host-terminal-count-fixture'
import {
  makeCreatedAgentWorktree as makeWorktree,
  seedAlreadyActiveWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/worktree-activation-created-agent.test-fixture'
import '../runtime/runtime-environment-bridge-fixture'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const initialAppStoreState = useAppStore.getState()

/** Activates and asserts a focusable tab appeared with no queued startup, returning its id. */
function activateAndExpectNoRelaunch(
  worktreeId: string,
  opts?: Parameters<typeof activateAndRevealWorktree>[1]
): string {
  const result = activateAndRevealWorktree(worktreeId, opts)
  const tabId = result === false ? undefined : (result.primaryTabId ?? undefined)

  expect(tabId).toBeDefined()
  expect(useAppStore.getState().pendingStartupByTabId[tabId!]).toBeUndefined()
  return tabId!
}

afterEach(() => {
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  vi.unstubAllGlobals()
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetWebRuntimeWakeTerminalRespawnForTests()
  useAppStore.setState(initialAppStoreState, true)
})

describe('activateAndRevealWorktree', () => {
  it('does not restamp focus recency when reselecting the already-active terminal worktree', () => {
    const worktree = makeWorktree()
    const { revealWorktreeInSidebar } = seedAlreadyActiveWorktree(worktree)
    const before = useAppStore.getState()

    const result = activateAndRevealWorktree(worktree.id)

    expect(result).toEqual({ primaryTabId: null })
    expect(useAppStore.getState().lastVisitedAtByWorktreeId).toBe(before.lastVisitedAtByWorktreeId)
    expect(useAppStore.getState().worktreeNavHistory).toBe(before.worktreeNavHistory)
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith(worktree.id)
  })

  it('records a visit when activating the same worktree changes the current view', () => {
    const worktree = makeWorktree()
    seedAlreadyActiveWorktree(worktree, { activeView: 'tasks' })

    const result = activateAndRevealWorktree(worktree.id)

    expect(result).toEqual({ primaryTabId: null })
    const state = useAppStore.getState()
    expect(getWorktreeVisitTimestamp(state.lastVisitedAtByWorktreeId, worktree)).toBeDefined()
    expect(state.worktreeNavHistory.at(-1)).toBe(worktree.id)
  })

  it('keeps the fresh visit stamp when the history entry is de-duplicated', () => {
    const worktree = makeWorktree()
    seedAlreadyActiveWorktree(worktree, { activeView: 'tasks' })
    useAppStore.setState({ worktreeNavHistory: [worktree.id], worktreeNavHistoryIndex: 0 })

    activateAndRevealWorktree(worktree.id)

    const state = useAppStore.getState()
    expect(getWorktreeVisitTimestamp(state.lastVisitedAtByWorktreeId, worktree)).toBeDefined()
    expect(state.worktreeNavHistory).toEqual([worktree.id])
  })

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

  it('does not relaunch on repeated activate/close cycles', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)

    for (let cycle = 0; cycle < 3; cycle += 1) {
      activateAndExpectNoRelaunch(worktree.id)

      // Return directly to zero tabs; closeTab’s sleeping purge is covered by worktree-reactivation-tab-forkbomb.test.ts.
      useAppStore.setState({ tabsByWorktree: {}, activeTabIdByWorktree: {} })
    }
  })

  it('still queues an explicit startup supplied by the caller', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)

    const result = activateAndRevealWorktree(worktree.id, {
      startup: { command: 'codex' }
    })
    const state = useAppStore.getState()
    const tabId = result === false ? undefined : (result.primaryTabId ?? undefined)

    expect(tabId).toBeDefined()
    expect(state.pendingStartupByTabId[tabId!]).toEqual(
      expect.objectContaining({ command: 'codex' })
    )
  })
})
