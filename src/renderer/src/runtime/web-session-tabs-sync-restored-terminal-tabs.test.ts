import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { hydrateWorkspaceTerminalRows } from '../store/slices/terminal-session-row-hydration'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
import { shouldReplaceTerminalTab } from './web-session-tabs-sync/terminal-surfaces'
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

/** A persisted remote tab whose PTY id is stale after restart. */
function makePersistedRow(id: string, title: string, sortOrder: number): TerminalTab {
  return {
    id,
    ptyId: `remote:${ENV}@@persisted-${id}`,
    worktreeId: WT,
    title,
    customTitle: title,
    color: null,
    sortOrder,
    createdAt: NOW - 10
  }
}

/** Runs real session hydration so the rows carry the exact restored placeholder shape. */
function hydrateRestoredRows(): TerminalTab[] {
  const persisted = [
    makePersistedRow('restored-tab-a', 'build', 0),
    makePersistedRow('restored-tab-b', 'logs', 1)
  ]
  const session = { ...getDefaultWorkspaceSession(), tabsByWorktree: { [WT]: persisted } }
  return hydrateWorkspaceTerminalRows(session, WT, persisted).rows
}

const UNRELATED_HOST_TERMINAL = {
  type: 'terminal' as const,
  id: HOST_SURFACE_ID,
  title: 'host shell',
  parentTabId: 'host-tab-1',
  leafId: LEAF_ID,
  isActive: true,
  status: 'ready' as const,
  terminal: 'terminal-1'
}

describe('restored terminal tabs vs. runtime host snapshots', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('keeps every restored tab when the host publishes an unrelated ready terminal', () => {
    const restored = hydrateRestoredRows()
    expect(restored.map((tab) => [tab.ptyId, tab.pendingActivationSpawn])).toEqual([
      [null, true],
      [null, true]
    ])

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: restored },
        activeTabId: 'restored-tab-b',
        activeTabIdByWorktree: { [WT]: 'restored-tab-b' }
      }),
      makeSnapshot([UNRELATED_HOST_TERMINAL]),
      ENV,
      NOW
    )

    const ids = patch.tabsByWorktree?.[WT]?.map((tab) => tab.id) ?? []
    expect(ids).toEqual(expect.arrayContaining(['restored-tab-a', 'restored-tab-b']))
    expect(ids).toHaveLength(3)
    expect(
      patch.tabsByWorktree?.[WT]
        ?.filter((tab) => tab.id.startsWith('restored-'))
        .map((tab) => tab.customTitle)
    ).toEqual(['build', 'logs'])
  })

  it('stops protecting a restored tab once it has been mounted', () => {
    const [restored] = hydrateRestoredRows()
    const remotePtyIds = new Set([`remote:${ENV}@@terminal-1`])
    expect(shouldReplaceTerminalTab(restored, ENV, remotePtyIds, new Set(), new Set())).toBe(false)

    const { restoredFromPersistence: _restored, ...mounted } = restored
    void _restored
    expect(shouldReplaceTerminalTab(mounted, ENV, remotePtyIds, new Set(), new Set())).toBe(true)
  })
})
