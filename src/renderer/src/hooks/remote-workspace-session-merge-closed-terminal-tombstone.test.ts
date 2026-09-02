import { afterEach, describe, expect, it, vi } from 'vitest'

import { mergeDirectSshRemoteWorkspaceSession } from './remote-workspace-session-merge'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import {
  makeCreatedAgentWorktree as makeWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/worktree-activation-created-agent-test-state'
import { useAppStore } from '@/store'

/**
 * The closed-last-terminal tombstone across a direct-SSH reconnect, end to end.
 *
 * The unit-level rule lives in remote-workspace-session-merge-local-survival.test.ts; this asserts
 * what that rule is FOR. `Object.hasOwn(tabsByWorktree, worktreeId)` has to keep meaning one thing
 * — the merge dropping the key turned "the user closed the last terminal" into "never
 * initialized", and the seeding pass then handed the terminal back on every reconnect.
 */
const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

/** The state a workspace lands in once its last terminal is closed: an explicit empty row. */
function seedClosedLastTerminal(worktreeId: string): void {
  useAppStore.setState({ tabsByWorktree: { [worktreeId]: [] } })
  expect(useAppStore.getState().reconcileWorktreeTabModel(worktreeId).renderableTabCount).toBe(0)
}

/** The real merge against a host that has no row for this worktree, hydrated the way
 *  remote-workspace-snapshot-apply does it. */
function applyHostSnapshotOmitting(worktreeId: string): void {
  const state = useAppStore.getState()
  const merged = mergeDirectSshRemoteWorkspaceSession(
    buildWorkspaceSessionPayload(state),
    getDefaultWorkspaceSession(),
    new Set([worktreeId]),
    state.tabsByWorktree,
    new Set()
  )
  const replaceWorkspaceKeys = [worktreeId]
  useAppStore.getState().hydrateWorkspaceSession(merged, { replaceWorkspaceKeys })
  useAppStore.getState().hydrateTabsSession(merged, { replaceWorkspaceKeys })
}

describe('a closed-last-terminal row that a direct-SSH snapshot says nothing about', () => {
  it('survives the reconnect, so startup hydration adds no terminal', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)

    applyHostSnapshotOmitting(worktree.id)

    expect(Object.hasOwn(useAppStore.getState().tabsByWorktree, worktree.id)).toBe(true)
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
    expect(ensureWorktreeHasInitialTerminal(useAppStore.getState(), worktree.id)).toBeNull()
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
  })

  it('still re-seeds when the user explicitly opens the workspace', () => {
    // The mirror risk of preserving the row rather than dropping it: the tombstone must suppress
    // seeding on startup hydration ONLY. An explicit activation opts into reseedEmptiedWorkspace,
    // and a preserved row that swallowed it would trade a duplicate terminal for a dead workspace.
    // Passes before the merge fix too — it is the guard on it, not evidence of it.
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)

    applyHostSnapshotOmitting(worktree.id)
    const result = activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })

    expect(result).not.toBe(false)
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toHaveLength(1)
  })
})
