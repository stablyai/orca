import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane
} from '../components/terminal-pane/renderer-owned-agent-status-registry'
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

describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('remaps host agent status onto mirrored terminal pane keys', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'codex [working]',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1',
          agentStatus: {
            state: 'working',
            prompt: 'fix web parity',
            updatedAt: NOW - 100,
            stateStartedAt: NOW - 1_000,
            agentType: 'codex',
            paneKey: hostPaneKey,
            tabId: 'host-tab-1',
            worktreeId: WT,
            terminalTitle: 'codex [working]',
            providerSession: { key: 'session_id', id: 'session-1' },
            stateHistory: []
          }
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    const mirroredPaneKey = makePaneKey(mirroredId!, LEAF_ID)
    expect(patch.agentStatusByPaneKey?.[mirroredPaneKey]).toMatchObject({
      state: 'working',
      prompt: 'fix web parity',
      agentType: 'codex',
      paneKey: mirroredPaneKey,
      tabId: mirroredId,
      worktreeId: WT,
      providerSession: { key: 'session_id', id: 'session-1' },
      terminalTitle: 'codex [working]'
    })
    expect(patch.agentStatusByPaneKey?.[mirroredPaneKey]?.updatedAt).toBe(NOW - 100)
    expect(patch.agentStatusByPaneKey?.[mirroredPaneKey]?.localReceiptAt).toBe(NOW)
    expect(patch.agentStatusByPaneKey?.[hostPaneKey]).toBeUndefined()
    expect(patch.agentStatusEpoch).toBe(1)
    expect(patch.sortEpoch).toBe(1)
  })

  it.each([10 * 60_000, -10 * 60_000])(
    'decays a mirrored host row from local receipt despite a %sms host clock skew',
    (skewMs) => {
      const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
      const hostUpdatedAt = NOW + skewMs
      const patch = applyWebSessionTabsSnapshot(
        makeState(),
        makeSnapshot([
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'codex [working]',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-1',
            agentStatus: {
              state: 'working',
              prompt: 'fix web parity',
              updatedAt: hostUpdatedAt,
              stateStartedAt: hostUpdatedAt,
              paneKey: hostPaneKey,
              stateHistory: [],
              // A peer must not be able to choose the renderer's receipt clock.
              localReceiptAt: hostUpdatedAt
            }
          }
        ]),
        ENV,
        NOW
      ) as Partial<WebSessionTabsSyncState>
      const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
      const mirroredPaneKey = makePaneKey(mirroredId!, LEAF_ID)
      const entry = patch.agentStatusByPaneKey?.[mirroredPaneKey]

      expect(entry?.updatedAt).toBe(hostUpdatedAt)
      expect(entry?.localReceiptAt).toBe(NOW)
      expect(isExplicitAgentStatusFresh(entry!, NOW, 30 * 60_000)).toBe(true)
      expect(isExplicitAgentStatusFresh(entry!, NOW + 30 * 60_000 + 1, 30 * 60_000)).toBe(false)
    }
  )

  it('preserves receipt time for an identical host replay to prevent stale-cache immortality', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const snapshot = makeSnapshot([
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        title: 'codex [working]',
        parentTabId: 'host-tab-1',
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'working',
          prompt: 'fix web parity',
          updatedAt: NOW - 10 * 60_000,
          stateStartedAt: NOW - 10 * 60_000,
          paneKey: hostPaneKey,
          stateHistory: []
        }
      }
    ])
    const firstPatch = applyWebSessionTabsSnapshot(
      makeState(),
      snapshot,
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const firstState = { ...makeState(), ...firstPatch }
    const secondNow = NOW + 1_000
    const secondPatch = applyWebSessionTabsSnapshot(
      firstState,
      { ...snapshot, snapshotVersion: 2 },
      ENV,
      secondNow
    ) as Partial<WebSessionTabsSyncState>
    const mirroredPaneKey = Object.keys(firstPatch.agentStatusByPaneKey ?? {})[0]!
    const repeated = secondPatch.agentStatusByPaneKey?.[mirroredPaneKey]

    expect(repeated?.updatedAt).toBe(NOW - 10 * 60_000)
    expect(repeated?.localReceiptAt).toBe(NOW)
  })

  it('does not refresh or invent a receipt when a client-owned host surface has no status', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const initial = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'codex [working]',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1',
          agentStatus: {
            state: 'working',
            prompt: 'fix web parity',
            updatedAt: NOW - 10 * 60_000,
            stateStartedAt: NOW - 10 * 60_000,
            paneKey: hostPaneKey,
            stateHistory: []
          }
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const initialState = { ...makeState(), ...initial }
    const release = registerRendererOwnedAgentStatusPane(
      makePaneKey(toWebTerminalSurfaceTabId('host-tab-1'), LEAF_ID),
      ENV
    )
    try {
      const mirroredPaneKey = Object.keys(initial.agentStatusByPaneKey ?? {})[0]!
      markRendererOwnedAgentStatusWrite(mirroredPaneKey)
      const before = initialState.agentStatusByPaneKey[mirroredPaneKey]
      const patch = applyWebSessionTabsSnapshot(
        initialState,
        makeSnapshot(
          [
            {
              type: 'terminal',
              id: HOST_SURFACE_ID,
              title: 'codex [working]',
              parentTabId: 'host-tab-1',
              leafId: LEAF_ID,
              isActive: true,
              status: 'ready',
              terminal: 'terminal-1'
            }
          ],
          { snapshotVersion: 2 }
        ),
        ENV,
        NOW + 1_000
      ) as Partial<WebSessionTabsSyncState>

      expect(patch.agentStatusByPaneKey?.[mirroredPaneKey]).toEqual(before)
    } finally {
      release()
    }
  })

  it('applies a marker-only host restart degradation to mirrored agent status', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const snapshot = makeSnapshot([
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        title: 'codex [working]',
        parentTabId: 'host-tab-1',
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'working',
          prompt: 'fix web parity',
          updatedAt: NOW - 100,
          stateStartedAt: NOW - 1_000,
          agentType: 'codex',
          paneKey: hostPaneKey,
          tabId: 'host-tab-1',
          worktreeId: WT,
          stateHistory: []
        }
      }
    ])
    const initial = applyWebSessionTabsSnapshot(
      makeState(),
      snapshot,
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const mirroredPaneKey = Object.keys(initial.agentStatusByPaneKey ?? {})[0]!
    const degraded = applyWebSessionTabsSnapshot(
      makeState({ ...initial }),
      {
        ...snapshot,
        snapshotVersion: 2,
        tabs: snapshot.tabs.map((tab) =>
          tab.type === 'terminal' && tab.agentStatus
            ? {
                ...tab,
                agentStatus: { ...tab.agentStatus, restoredUnconfirmed: true }
              }
            : tab
        )
      },
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(degraded.agentStatusByPaneKey?.[mirroredPaneKey]?.restoredUnconfirmed).toBe(true)
    expect(degraded.agentStatusEpoch).toBe(2)
    expect(degraded.sortEpoch).toBe(2)
  })

  it('repairs mirrored same-state attribution and retains identity from an older snapshot', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const snapshot = makeSnapshot([
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        title: 'codex [working]',
        parentTabId: 'host-tab-1',
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'working',
          prompt: 'fix web parity',
          updatedAt: NOW - 100,
          stateStartedAt: NOW - 1_000,
          agentType: 'codex',
          paneKey: hostPaneKey,
          worktreeId: WT,
          tabId: 'host-tab-1',
          providerSession: { key: 'session_id', id: 'session-1' },
          stateHistory: []
        }
      }
    ])
    const initial = applyWebSessionTabsSnapshot(
      makeState(),
      snapshot,
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const mirroredPaneKey = Object.keys(initial.agentStatusByPaneKey ?? {})[0]!
    const existing = initial.agentStatusByPaneKey![mirroredPaneKey]!
    const attributionPatch = applyWebSessionTabsSnapshot(
      makeState({
        ...initial,
        agentStatusByPaneKey: {
          [mirroredPaneKey]: {
            ...existing,
            worktreeId: 'stale-worktree',
            tabId: 'stale-tab'
          }
        },
        agentStatusEpoch: 7,
        sortEpoch: 11
      }),
      { ...snapshot, snapshotVersion: 2 },
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(attributionPatch.agentStatusByPaneKey?.[mirroredPaneKey]).toMatchObject({
      worktreeId: existing.worktreeId,
      tabId: existing.tabId
    })
    expect(attributionPatch.agentStatusEpoch).toBe(8)
    expect(attributionPatch.sortEpoch).toBe(12)

    const fresherAttributionPatch = applyWebSessionTabsSnapshot(
      makeState({
        ...initial,
        agentStatusByPaneKey: {
          [mirroredPaneKey]: {
            ...existing,
            updatedAt: NOW,
            worktreeId: 'stale-worktree',
            tabId: 'stale-tab',
            providerSession: undefined
          }
        },
        agentStatusEpoch: 7,
        sortEpoch: 11
      }),
      { ...snapshot, snapshotVersion: 3 },
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(fresherAttributionPatch.agentStatusByPaneKey?.[mirroredPaneKey]).toMatchObject({
      worktreeId: existing.worktreeId,
      tabId: existing.tabId,
      updatedAt: NOW,
      providerSession: { key: 'session_id', id: 'session-1' }
    })
    expect(fresherAttributionPatch.agentStatusEpoch).toBe(8)
    expect(fresherAttributionPatch.sortEpoch).toBe(12)

    const identityPatch = applyWebSessionTabsSnapshot(
      makeState({
        ...initial,
        ...attributionPatch,
        agentStatusByPaneKey: {
          [mirroredPaneKey]: {
            ...attributionPatch.agentStatusByPaneKey![mirroredPaneKey]!,
            updatedAt: NOW,
            providerSession: undefined
          }
        }
      }),
      { ...snapshot, snapshotVersion: 4 },
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(identityPatch.agentStatusByPaneKey?.[mirroredPaneKey]?.providerSession).toEqual({
      key: 'session_id',
      id: 'session-1'
    })
    expect(identityPatch.agentStatusByPaneKey?.[mirroredPaneKey]?.updatedAt).toBe(NOW)
    expect(identityPatch.agentStatusEpoch).toBe(8)
    expect(identityPatch.sortEpoch).toBe(12)

    const nextTurnPatch = applyWebSessionTabsSnapshot(
      makeState({
        ...initial,
        agentStatusByPaneKey: {
          [mirroredPaneKey]: {
            ...existing,
            state: 'working',
            updatedAt: NOW,
            stateStartedAt: NOW,
            worktreeId: 'stale-worktree',
            tabId: 'stale-tab',
            providerSession: undefined
          }
        }
      }),
      {
        ...snapshot,
        snapshotVersion: 5,
        tabs: snapshot.tabs.map((tab) =>
          tab.type === 'terminal' && tab.agentStatus
            ? {
                ...tab,
                agentStatus: {
                  ...tab.agentStatus,
                  state: 'done',
                  providerSession: { key: 'session_id', id: 'previous-session' }
                }
              }
            : tab
        )
      },
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(nextTurnPatch.agentStatusByPaneKey?.[mirroredPaneKey]).toMatchObject({
      state: 'working',
      stateStartedAt: NOW,
      worktreeId: WT,
      tabId: existing.tabId
    })
    expect(nextTurnPatch.agentStatusByPaneKey?.[mirroredPaneKey]?.providerSession).toBeUndefined()
  })

  it('keeps mirrored OMP tabs from repainting to Pi-compatible titles', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Pi ready',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1',
          launchAgent: 'omp',
          agentStatus: {
            state: 'done',
            prompt: '',
            updatedAt: NOW - 100,
            stateStartedAt: NOW - 1_000,
            agentType: 'pi',
            paneKey: hostPaneKey,
            terminalTitle: 'Pi ready',
            stateHistory: []
          }
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    const mirroredPaneKey = makePaneKey(mirroredId!, LEAF_ID)
    expect(patch.tabsByWorktree?.[WT]?.[0]).toMatchObject({
      title: 'OMP ready',
      launchAgent: 'omp'
    })
    expect(patch.agentStatusByPaneKey?.[mirroredPaneKey]).toMatchObject({
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })

  it('bumps sort epoch for mirrored Command Code same-state turn starts', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const initialPatch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Command Code',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1',
          agentStatus: {
            state: 'working',
            prompt: 'same prompt',
            updatedAt: NOW - 1_000,
            stateStartedAt: NOW - 1_000,
            agentType: 'command-code',
            paneKey: hostPaneKey,
            terminalTitle: 'Command Code',
            stateHistory: [],
            promptInteractionKey: 'command-code-transcript-a'
          }
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const initialState = { ...makeState(), ...initialPatch }
    const mirroredId = initialPatch.tabsByWorktree?.[WT]?.[0]?.id
    const mirroredPaneKey = makePaneKey(mirroredId!, LEAF_ID)

    const patch = applyWebSessionTabsSnapshot(
      initialState,
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'Command Code',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-1',
            agentStatus: {
              state: 'working',
              prompt: 'same prompt',
              updatedAt: NOW,
              stateStartedAt: NOW,
              agentType: 'command-code',
              paneKey: hostPaneKey,
              terminalTitle: 'Command Code',
              stateHistory: [],
              promptInteractionKey: 'command-code-transcript-b'
            }
          }
        ],
        { snapshotVersion: 2 }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.agentStatusByPaneKey?.[mirroredPaneKey]).toMatchObject({
      prompt: 'same prompt',
      stateStartedAt: NOW,
      promptInteractionKey: 'command-code-transcript-b'
    })
    expect(patch.agentStatusEpoch).toBe((initialState.agentStatusEpoch ?? 0) + 1)
    expect(patch.sortEpoch).toBe((initialState.sortEpoch ?? 0) + 1)
  })

  it('bumps sort epoch when a mirrored same-state done update becomes a completion', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const initialSnapshot = makeSnapshot([
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        title: 'Codex',
        parentTabId: 'host-tab-1',
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'done',
          prompt: 'same prompt',
          updatedAt: NOW - 1_000,
          stateStartedAt: NOW - 2_000,
          agentType: 'codex',
          paneKey: hostPaneKey,
          stateHistory: [],
          interrupted: true
        }
      }
    ])
    const initialPatch = applyWebSessionTabsSnapshot(
      makeState(),
      initialSnapshot,
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const initialState = { ...makeState(), ...initialPatch }

    const patch = applyWebSessionTabsSnapshot(
      initialState,
      {
        ...initialSnapshot,
        snapshotVersion: 2,
        tabs: initialSnapshot.tabs.map((tab) =>
          tab.type === 'terminal' && tab.agentStatus
            ? {
                ...tab,
                agentStatus: {
                  ...tab.agentStatus,
                  updatedAt: NOW,
                  interrupted: undefined
                }
              }
            : tab
        )
      },
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.agentStatusEpoch).toBe((initialState.agentStatusEpoch ?? 0) + 1)
    expect(patch.sortEpoch).toBe((initialState.sortEpoch ?? 0) + 1)
  })
})
