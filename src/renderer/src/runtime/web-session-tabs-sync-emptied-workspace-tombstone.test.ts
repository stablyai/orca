import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
  type RuntimeMobileSessionTabsRemovedResult
} from '../../../shared/runtime-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

const hostTerminalSnapshot = (): ReturnType<typeof makeSnapshot> =>
  makeSnapshot([
    {
      type: 'terminal',
      id: HOST_SURFACE_ID,
      parentTabId: 'host-tab-1',
      leafId: LEAF_ID,
      title: 'Terminal',
      status: 'ready',
      terminal: 'terminal-1',
      isActive: true
    }
  ])

const emptySnapshot = (
  overrides: Partial<ReturnType<typeof makeSnapshot>> = {}
): ReturnType<typeof makeSnapshot> =>
  makeSnapshot([], {
    snapshotVersion: 2,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    ...overrides
  })

// Missing tabs row means never initialized; explicit empty means user closed the last terminal. Preserve that tombstone or every focus reseeds (STA-6173, initial-terminal.ts).
describe('applyWebSessionTabsSnapshot emptied-workspace tombstone', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('leaves an explicit empty row when the host retracts the last terminal', () => {
    const mirrored = applyWebSessionTabsSnapshot(
      makeState(),
      hostTerminalSnapshot(),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const mirroredTabs = mirrored.tabsByWorktree?.[WT] as TerminalTab[]
    expect(mirroredTabs).toHaveLength(1)

    const patch = applyWebSessionTabsSnapshot(
      makeState({ tabsByWorktree: { [WT]: mirroredTabs } }),
      emptySnapshot(),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree).toBeDefined()
    expect(Object.hasOwn(patch.tabsByWorktree!, WT)).toBe(true)
    expect(patch.tabsByWorktree![WT]).toEqual([])
  })

  it('does not invent a row for a workspace the host has never had terminals in', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      emptySnapshot(),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree === undefined || !Object.hasOwn(patch.tabsByWorktree, WT)).toBe(
      true
    )
  })

  it('drops the row on a worktree removal frame instead of tombstoning a workspace that is gone', () => {
    const mirrored = applyWebSessionTabsSnapshot(
      makeState(),
      hostTerminalSnapshot(),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const mirroredTabs = mirrored.tabsByWorktree?.[WT] as TerminalTab[]

    const patch = applyWebSessionTabsSnapshot(
      makeState({ tabsByWorktree: { [WT]: mirroredTabs } }),
      { ...emptySnapshot(), removed: true } as RuntimeMobileSessionTabsRemovedResult,
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree).toBeDefined()
    expect(Object.hasOwn(patch.tabsByWorktree!, WT)).toBe(false)
  })

  // Synthesized empty frames from unpublished worktrees mean ask later, not user-emptied.
  it('does not tombstone from a synthesized unpublished frame', () => {
    const mirrored = applyWebSessionTabsSnapshot(
      makeState(),
      hostTerminalSnapshot(),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const mirroredTabs = mirrored.tabsByWorktree?.[WT] as TerminalTab[]

    const patch = applyWebSessionTabsSnapshot(
      makeState({ tabsByWorktree: { [WT]: mirroredTabs } }),
      emptySnapshot({
        publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
        snapshotVersion: 0
      }),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree).toBeDefined()
    expect(Object.hasOwn(patch.tabsByWorktree!, WT)).toBe(false)
  })
})
