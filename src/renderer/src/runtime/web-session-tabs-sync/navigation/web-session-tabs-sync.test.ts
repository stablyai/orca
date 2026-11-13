import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import '../../../../../shared/agent-session/view/structured-agent-session-projection'
import '../../../../../shared/constants'
import {
  clearWebSessionCloseIntent,
  recordWebSessionCloseIntent
} from '../closing/web-session-close-intent'
import { recordWebSessionReorderIntent } from './web-session-reorder-intent'

import { acceptReplayedWebSessionTabsSnapshot, type WebSessionTabsSyncState } from '../state'
import { applyFreshWebSessionTabsSnapshot, applyWebSessionTabsSnapshot } from '../snapshot-api'
import '../tracking-mappings'
import '../tracking-decisions'
import '../tracking'

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
} from '../testing/web-session-tabs-sync.test-fixture'

vi.mock('../../../store/index', () => ({
  useAppStore: {
    setState: vi.fn(),
    // Snapshot receipt reads the held paired-tab closes; none here.
    getState: () => ({})
  }
}))

vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))
describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

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

    // Host omission clears close intent; a genuinely new tab reusing that ID must show.
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

    // Live-PTY refusal needs unchanged snapshot replay immediately, without waiting for a publish.
    clearWebSessionCloseIntent({ environmentId: ENV }, WT, 'host-tab-1')
    acceptReplayedWebSessionTabsSnapshot(ENV, WT)
    const restoredPatch = applyFreshWebSessionTabsSnapshot(hidden, authoritative, ENV, NOW + 1)
    const restored = { ...hidden, ...(restoredPatch as Partial<WebSessionTabsSyncState>) }
    expect((restored.tabsByWorktree[WT] ?? []).map((tab) => tab.id)).toContain(
      toWebTerminalSurfaceTabId('host-tab-1')
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

    // Optimistic reorder must survive in-flight pre-move host order.
    recordWebSessionReorderIntent({ environmentId: ENV }, WT, 'host-group-1', [local2, local1], NOW)
    const stalePreMove = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(surfaces, { tabGroups: groupWithOrder(['host-tab-1', 'host-tab-2']) }),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    expect(stalePreMove.groupsByWorktree?.[WT]?.[0]?.tabOrder).toEqual([local2, local1])

    // Host confirmation clears reorder intent; later host order changes must apply.
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
