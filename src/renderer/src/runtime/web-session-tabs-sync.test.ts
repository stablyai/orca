import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  clearWebSessionCloseIntent,
  isWebSessionCloseIntentPending,
  recordWebSessionCloseIntent
} from './web-session-close-intent'
import { recordWebSessionReorderIntent } from './web-session-reorder-intent'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  acceptReplayedWebSessionTabsSnapshot,
  applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot,
  resolveHostSessionTabIdForWebSessionTab,
  shouldApplyWebSessionTabsSnapshot,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
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

vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))
describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('projects structured agent sessions as native unified tabs', () => {
    const agentTab = {
      type: 'agent-session' as const,
      id: 'agent-session:session-1',
      title: 'Codex Chat',
      sessionId: 'session-1',
      agent: 'codex' as const,
      isActive: true
    }
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([agentTab], {
        activeTabId: agentTab.id,
        activeTabType: 'agent-session',
        tabGroups: [
          {
            id: 'host-group-1',
            activeTabId: agentTab.id,
            tabOrder: [agentTab.id]
          }
        ]
      }),
      ENV,
      NOW
    )

    expect(patch.unifiedTabsByWorktree?.[WT]).toEqual([
      expect.objectContaining({
        id: 'structured-agent-session-session-1',
        entityId: 'session-1',
        contentType: 'agent-session',
        agentSessionAgent: 'codex'
      })
    ])
    expect(patch.activeTabTypeByWorktree?.[WT]).toBe('agent-session')
    expect(
      resolveHostSessionTabIdForWebSessionTab(
        { ...makeState(), ...patch },
        { environmentId: ENV, worktreeId: WT, tabId: 'structured-agent-session-session-1' }
      )
    ).toBe(agentTab.id)
  })

  it('removes a restored structured tab when the host publishes no structured sessions', () => {
    const structuredTab: Tab = {
      id: 'structured-agent-session-session-1',
      entityId: 'session-1',
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      label: 'Codex Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }
    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeTabId: structuredTab.id,
        activeTabIdByWorktree: { [WT]: structuredTab.id },
        activeTabType: 'agent-session',
        activeTabTypeByWorktree: { [WT]: 'agent-session' },
        unifiedTabsByWorktree: { [WT]: [structuredTab] },
        tabBarOrderByWorktree: { [WT]: [structuredTab.id] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: structuredTab.id,
              tabOrder: [structuredTab.id]
            }
          ]
        }
      }),
      makeSnapshot([], { activeTabType: null }),
      ENV,
      NOW
    )

    expect(patch.unifiedTabsByWorktree?.[WT]).toBeUndefined()
    expect(patch.activeTabTypeByWorktree?.[WT]).toBe('terminal')
  })

  it('ignores stale or duplicate same-epoch snapshots after a newer version was applied', () => {
    const state = makeState()
    const newer = makeSnapshot([], { snapshotVersion: 3, activeTabType: null })
    const older = makeSnapshot([], { snapshotVersion: 2, activeTabType: null })

    const first = applyFreshWebSessionTabsSnapshot(state, newer, ENV, NOW)
    const afterNewer = { ...state, ...(first as Partial<WebSessionTabsSyncState>) }
    const second = applyFreshWebSessionTabsSnapshot(afterNewer, older, ENV, NOW)

    expect(second).toBe(afterNewer)
    expect(applyFreshWebSessionTabsSnapshot(afterNewer, newer, ENV, NOW)).toBe(afterNewer)
  })

  it('applies a lower-version snapshot from a different epoch (host restart safety)', () => {
    // Why: snapshotVersion resets when the host restarts, and a restart produces
    // a new publicationEpoch. Since the client's freshness tracking survives a
    // transparent transport reconnect, rejecting on version alone would
    // permanently drop the post-restart snapshot. A different epoch must apply
    // even at a lower version; only same-epoch non-newer frames are stale.
    const before = makeSnapshot([], {
      publicationEpoch: 'epoch-gen-1',
      snapshotVersion: 10,
      activeTabType: null
    })
    const afterRestart = makeSnapshot([], {
      publicationEpoch: 'epoch-gen-2',
      snapshotVersion: 1,
      activeTabType: null
    })

    expect(shouldApplyWebSessionTabsSnapshot(before, ENV)).toBe(true)
    expect(shouldApplyWebSessionTabsSnapshot(afterRestart, ENV)).toBe(true)
    // Same-epoch non-newer frames are still rejected as stale/duplicate.
    const sameEpochOlder = makeSnapshot([], {
      publicationEpoch: 'epoch-gen-2',
      snapshotVersion: 1,
      activeTabType: null
    })
    expect(shouldApplyWebSessionTabsSnapshot(sameEpochOlder, ENV)).toBe(false)
  })

  it('accepts a replayed same-epoch same-version snapshot after a transport reconnect', () => {
    // Why: after a shared-control reconnect the server re-emits the current
    // snapshot with an UNCHANGED epoch/version (the host did not restart).
    // Without the replay reset the monotonic gate rejects it and the mirror
    // stays frozen (#7718).
    const snapshot = makeSnapshot([], { snapshotVersion: 5, activeTabType: null })

    expect(shouldApplyWebSessionTabsSnapshot(snapshot, ENV)).toBe(true)
    // Same frame again during normal operation: still rejected as stale.
    expect(shouldApplyWebSessionTabsSnapshot(snapshot, ENV)).toBe(false)

    acceptReplayedWebSessionTabsSnapshot(ENV, snapshot.worktree)
    const older = makeSnapshot([], { snapshotVersion: 4, activeTabType: null })
    expect(shouldApplyWebSessionTabsSnapshot(older, ENV)).toBe(false)
    expect(shouldApplyWebSessionTabsSnapshot(snapshot, ENV)).toBe(true)

    // The replay reset re-primes tracking: ordering protection resumes for
    // subsequent frames (an older same-epoch frame is still rejected).
    expect(shouldApplyWebSessionTabsSnapshot(older, ENV)).toBe(false)
    const newer = makeSnapshot([], { snapshotVersion: 6, activeTabType: null })
    expect(shouldApplyWebSessionTabsSnapshot(newer, ENV)).toBe(true)
  })

  it('scopes the replay reset to the replayed environment and worktree', () => {
    const snapshot = makeSnapshot([], { snapshotVersion: 5, activeTabType: null })
    const otherWorktree = makeSnapshot([], {
      worktree: 'repo::/other-worktree',
      snapshotVersion: 5,
      activeTabType: null
    })

    expect(shouldApplyWebSessionTabsSnapshot(snapshot, ENV)).toBe(true)
    expect(shouldApplyWebSessionTabsSnapshot(otherWorktree, ENV)).toBe(true)

    acceptReplayedWebSessionTabsSnapshot(ENV, snapshot.worktree)

    // Only the replayed worktree re-applies; the other stays gated.
    expect(shouldApplyWebSessionTabsSnapshot(otherWorktree, ENV)).toBe(false)
    expect(shouldApplyWebSessionTabsSnapshot(snapshot, ENV)).toBe(true)
  })

  it('ignores remote snapshots for the local floating workspace', () => {
    const floatingTab: TerminalTab = {
      id: 'floating-tab-1',
      ptyId: 'pty-floating-1',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      title: 'VPS tmux',
      defaultTitle: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }
    const floatingUnifiedTab: Tab = {
      id: floatingTab.id,
      entityId: floatingTab.id,
      groupId: 'floating-group',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      contentType: 'terminal',
      label: floatingTab.title,
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false
    }
    const state = makeState({
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] },
      ptyIdsByTabId: { [floatingTab.id]: ['pty-floating-1'] },
      unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingUnifiedTab] },
      groupsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: 'floating-group',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            activeTabId: floatingTab.id,
            tabOrder: [floatingTab.id],
            recentTabIds: [floatingTab.id]
          }
        ]
      },
      activeTabId: floatingTab.id,
      activeTabIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: floatingTab.id }
    })

    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([], {
        worktree: FLOATING_TERMINAL_WORKTREE_ID,
        activeTabId: null,
        activeTabType: null
      }),
      ENV,
      NOW
    )

    expect(patch).toBe(state)
  })

  it('suppresses a tab the client is closing until the host confirms removal (no close flash)', () => {
    const surface = {
      type: 'terminal' as const,
      id: HOST_SURFACE_ID,
      parentTabId: 'host-tab-1',
      leafId: LEAF_ID,
      title: 'Terminal',
      status: 'ready' as const,
      terminal: 'term_host',
      isActive: true
    }
    // Client closed host-tab-1; an in-flight pre-close snapshot still lists it.
    recordWebSessionCloseIntent({ environmentId: ENV }, WT, 'host-tab-1', NOW)
    const stalePreClose = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([surface]),
      ENV,
      NOW
    )
    expect((stalePreClose.tabsByWorktree?.[WT] ?? []).map((tab) => tab.id)).not.toContain(
      toWebTerminalSurfaceTabId('host-tab-1')
    )

    // The host's post-close snapshot omits the tab -> intent clears; a later
    // snapshot that re-adds the SAME id (a genuinely new tab) is no longer hidden.
    applyWebSessionTabsSnapshot(makeState(), makeSnapshot([]), ENV, NOW + 1)
    const reopened = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([surface], { snapshotVersion: 5 }),
      ENV,
      NOW + 2
    )
    expect((reopened.tabsByWorktree?.[WT] ?? []).map((tab) => tab.id)).toContain(
      toWebTerminalSurfaceTabId('host-tab-1')
    )
  })

  it('reapplies an unchanged host snapshot after a lifecycle close is refused', () => {
    const surface = {
      type: 'terminal' as const,
      id: HOST_SURFACE_ID,
      parentTabId: 'host-tab-1',
      leafId: LEAF_ID,
      title: 'Terminal',
      status: 'ready' as const,
      terminal: 'term_host',
      isActive: true
    }
    const authoritative = makeSnapshot([surface], { snapshotVersion: 6 })

    const initial = makeState()
    recordWebSessionCloseIntent({ environmentId: ENV }, WT, 'host-tab-1', NOW)
    const hiddenPatch = applyFreshWebSessionTabsSnapshot(initial, authoritative, ENV, NOW)
    const hidden = { ...initial, ...(hiddenPatch as Partial<WebSessionTabsSyncState>) }
    expect((hidden.tabsByWorktree[WT] ?? []).map((tab) => tab.id)).not.toContain(
      toWebTerminalSurfaceTabId('host-tab-1')
    )

    // The host vetoed lifecycle cleanup because the PTY is still live. Its
    // unchanged snapshot must become usable immediately, without a new publish.
    clearWebSessionCloseIntent({ environmentId: ENV }, WT, 'host-tab-1')
    acceptReplayedWebSessionTabsSnapshot(ENV, WT)
    const restoredPatch = applyFreshWebSessionTabsSnapshot(hidden, authoritative, ENV, NOW + 1)
    const restored = { ...hidden, ...(restoredPatch as Partial<WebSessionTabsSyncState>) }
    expect((restored.tabsByWorktree[WT] ?? []).map((tab) => tab.id)).toContain(
      toWebTerminalSurfaceTabId('host-tab-1')
    )
  })

  it('does not let a replay reset clear another close intent from an older snapshot', () => {
    const current = makeSnapshot([], { snapshotVersion: 6, activeTabType: null })
    expect(shouldApplyWebSessionTabsSnapshot(current, ENV)).toBe(true)
    recordWebSessionCloseIntent({ environmentId: ENV }, WT, 'host-tab-2', NOW)

    acceptReplayedWebSessionTabsSnapshot(ENV, WT)
    const state = makeState()
    const stalePatch = applyFreshWebSessionTabsSnapshot(
      state,
      makeSnapshot([], { snapshotVersion: 5, activeTabType: null }),
      ENV,
      NOW + 1
    )

    expect(stalePatch).toBe(state)
    expect(isWebSessionCloseIntentPending({ environmentId: ENV }, WT, 'host-tab-2', NOW + 1)).toBe(
      true
    )
  })

  it('keeps a client reorder until the host echoes it (no order snap-back)', () => {
    const local1 = toWebTerminalSurfaceTabId('host-tab-1')
    const local2 = toWebTerminalSurfaceTabId('host-tab-2')
    const surfaces: RuntimeMobileSessionTabsResult['tabs'] = [
      {
        type: 'terminal',
        id: `host-tab-1::${LEAF_ID}`,
        parentTabId: 'host-tab-1',
        leafId: LEAF_ID,
        title: 'Terminal 1',
        status: 'ready',
        terminal: 'term_host_1',
        isActive: true
      },
      {
        type: 'terminal',
        id: `host-tab-2::${SECOND_LEAF_ID}`,
        parentTabId: 'host-tab-2',
        leafId: SECOND_LEAF_ID,
        title: 'Terminal 2',
        status: 'ready',
        terminal: 'term_host_2',
        isActive: false
      }
    ]
    const groupWithOrder = (tabOrder: string[]): RuntimeMobileSessionTabsResult['tabGroups'] => [
      { id: 'host-group-1', activeTabId: 'host-tab-1', tabOrder }
    ]

    // Client dragged tab 2 ahead of tab 1; an in-flight snapshot still has the
    // original host order.
    recordWebSessionReorderIntent({ environmentId: ENV }, WT, 'host-group-1', [local2, local1], NOW)
    const stalePreMove = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(surfaces, { tabGroups: groupWithOrder(['host-tab-1', 'host-tab-2']) }),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    expect(stalePreMove.groupsByWorktree?.[WT]?.[0]?.tabOrder).toEqual([local2, local1])

    // The host's post-move snapshot echoes the new order -> intent clears; a
    // later snapshot reverting to the old order is no longer overridden.
    applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(surfaces, {
        snapshotVersion: 5,
        tabGroups: groupWithOrder(['host-tab-2', 'host-tab-1'])
      }),
      ENV,
      NOW + 1
    )
    const reverted = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(surfaces, {
        snapshotVersion: 6,
        tabGroups: groupWithOrder(['host-tab-1', 'host-tab-2'])
      }),
      ENV,
      NOW + 2
    ) as Partial<WebSessionTabsSyncState>
    expect(reverted.groupsByWorktree?.[WT]?.[0]?.tabOrder).toEqual([local1, local2])
  })
})
