import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorktreeAgentRows } from '../components/sidebar/worktree-agent-rows'
import { makePaneKey } from '../../../shared/stable-pane-id'
import * as sessionOrigin from '../../../shared/agent-session-start-time'
import { buildMirroredAgentStatusPatch } from './web-session-tabs-sync/agent-status-patch'
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

describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('resolves origins linearly without publishing equal paired snapshots', () => {
    const resolve = vi.spyOn(sessionOrigin, 'resolveAgentSessionStartedAt')
    try {
      const counts = [10, 100].map((population) => {
        let state = makeState()
        const surfaces = Array.from({ length: population }, (_, index) => ({
          type: 'terminal' as const,
          id: `host-${index}::${LEAF_ID}`,
          title: 'Claude',
          parentTabId: `host-${index}`,
          leafId: LEAF_ID,
          isActive: index === 0,
          status: 'ready' as const,
          terminal: `terminal-${index}`,
          agentStatus: {
            state: 'working' as const,
            prompt: 'task',
            agentType: 'claude',
            paneKey: makePaneKey(`host-${index}`, LEAF_ID),
            worktreeId: WT,
            updatedAt: NOW,
            stateStartedAt: NOW - 10_000,
            stateHistory: [],
            providerSession: { key: 'session_id' as const, id: `session-${index}` }
          }
        }))
        const patch = () =>
          buildMirroredAgentStatusPatch(state, [], surfaces, [], ENV, WT, new Set(), NOW)
        resolve.mockClear()
        state = { ...state, ...patch() }
        const initial = resolve.mock.calls.length
        expect(Object.keys(state.agentStatusByPaneKey)).toHaveLength(population)
        resolve.mockClear()
        expect(patch()).toBeNull()
        const repeated = resolve.mock.calls.length
        const epoch = state.sortEpoch
        surfaces[0].agentStatus = {
          ...surfaces[0].agentStatus,
          updatedAt: NOW + 1,
          providerSession: { key: 'session_id', id: 'replacement' }
        }
        resolve.mockClear()
        state = { ...state, ...patch() }
        expect(state.sortEpoch).toBe(epoch + 1)
        expect(state.agentStatusEpoch).toBe(2)
        expect(Object.values(state.agentStatusByPaneKey)[0].firstStateStartedAt).toBe(NOW + 1)
        return [initial, repeated, resolve.mock.calls.length]
      })
      expect(counts[0]).toEqual([10, 10, 10])
      expect(counts[1]).toEqual(counts[0].map((count) => count * 10))
    } finally {
      resolve.mockRestore()
    }
  })

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
    expect(patch.agentStatusByPaneKey?.[hostPaneKey]).toBeUndefined()
    expect(patch.agentStatusEpoch).toBe(1)
    expect(patch.sortEpoch).toBe(1)
  })

  it('clears stale tool-output provenance when a newer host preview is assistant prose', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const initialSnapshot = makeSnapshot([
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        title: 'claude [working]',
        parentTabId: 'host-tab-1',
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'working',
          prompt: 'fix web parity',
          updatedAt: NOW,
          stateStartedAt: NOW - 1_000,
          agentType: 'claude',
          paneKey: hostPaneKey,
          worktreeId: WT,
          terminalTitle: 'claude [working]',
          lastAssistantMessage: 'same preview',
          lastAssistantMessageIsToolOutput: true,
          stateHistory: []
        }
      }
    ])
    const initialPatch = applyWebSessionTabsSnapshot(
      makeState(),
      initialSnapshot,
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const mirroredPaneKey = Object.keys(initialPatch.agentStatusByPaneKey ?? {})[0]!

    const prosePatch = applyWebSessionTabsSnapshot(
      { ...makeState(), ...initialPatch },
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'claude [working]',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-1',
            agentStatus: {
              state: 'working',
              prompt: 'fix web parity',
              stateStartedAt: NOW - 1_000,
              agentType: 'claude',
              paneKey: hostPaneKey,
              worktreeId: WT,
              terminalTitle: 'claude [working]',
              lastAssistantMessage: 'same preview',
              stateHistory: [],
              updatedAt: NOW - 100,
              lastAssistantMessageIsToolOutput: undefined
            }
          }
        ],
        { snapshotVersion: 2 }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(prosePatch.agentStatusByPaneKey?.[mirroredPaneKey]?.lastAssistantMessage).toBe(
      'same preview'
    )
    expect(
      prosePatch.agentStatusByPaneKey?.[mirroredPaneKey]?.lastAssistantMessageIsToolOutput
    ).toBeUndefined()
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

it.each([false, true])(
  'keeps paired rows stable with rolling history=%s across host enrichment and replacement',
  (history) => {
    resetWebSessionTabsSyncTestState()
    let state = makeState()
    const order = () =>
      buildWorktreeAgentRows({
        tabs: state.tabsByWorktree[WT] ?? [],
        entries: Object.values(state.agentStatusByPaneKey),
        retained: [],
        now: NOW
      }).map((row) => row.paneKey)
    const update = (at: number, tick: number, session = 'A', origin?: number, stale = false) => {
      const tabs = [1, 2].map((index) => ({
        type: 'terminal' as const,
        id: `host-tab-${index}::${LEAF_ID}`,
        title: 'Claude',
        parentTabId: `host-tab-${index}`,
        leafId: LEAF_ID,
        isActive: index === 1,
        status: 'ready' as const,
        terminal: `terminal-${index}`,
        agentStatus: {
          state: 'working' as const,
          prompt: 'task',
          updatedAt: NOW + tick - (stale ? 100 : 0),
          stateStartedAt: NOW - (index === 1 ? 10000 - at : 8000),
          agentType: 'claude',
          paneKey: makePaneKey(`host-tab-${index}`, LEAF_ID),
          providerSession: { key: 'session_id' as const, id: index === 1 ? session : 'quiet' },
          ...(origin !== undefined ? { firstStateStartedAt: origin } : {}),
          stateHistory: history
            ? [
                {
                  state: 'done' as const,
                  prompt: '',
                  startedAt: NOW - (index === 1 ? 10000 - at : 8000)
                }
              ]
            : []
        }
      }))
      state = {
        ...state,
        ...applyWebSessionTabsSnapshot(
          state,
          makeSnapshot(tabs, { snapshotVersion: tick + 1 }),
          ENV,
          NOW + tick + 100_000
        )
      }
    }
    update(0, 0)
    const before = order()
    update(5000, 1, 'A', NOW - 5000)
    expect(order()).toEqual(before)
    const epoch = state.sortEpoch
    update(6000, 2, 'B', NOW - 5000)
    expect(order()).toEqual(before.toReversed())
    expect(state.agentStatusByPaneKey[before[0]!].firstStateStartedAt).toBe(NOW - 5000)
    expect(state.sortEpoch).toBeGreaterThan(epoch ?? 0)
    update(7000, 3, 'rejected-old-session', undefined, true)
    expect(state.agentStatusByPaneKey[before[0]!].firstStateStartedAt).toBe(NOW - 5000)
    update(6000, 4, 'legacy-next-session')
    expect(state.agentStatusByPaneKey[before[0]!].firstStateStartedAt).toBe(NOW + 4)
  }
)
