import { it, expect, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { AppState } from '../store/types'
import { structuredAgentSessionPaneKey } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { applyFreshWebSessionTabsSnapshots } from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import type { HostStatusRetirementHarness } from './web-session-tabs-sync-host-tab-retraction-ghost-rows.test'

export function registerHostStatusRetirementTests({
  seedPairedClientStore,
  makeHostSnapshot,
  makeShellSnapshot,
  applyHostSnapshot,
  replayRetainedAgentsSync,
  observeCurrentDisplay,
  mirrorPaneKey,
  KEEP_TAB,
  KEEP_LEAF,
  RETRACTED_TAB,
  RETRACTED_LEAF,
  ENV,
  T0
}: HostStatusRetirementHarness) {
  it('retires Done across mirror, retention and every display reader when the old-shaped host reports the same ready shell without status', () => {
    const store = seedPairedClientStore()
    const done = makeHostSnapshot({
      snapshotVersion: 1,
      hostTabIds: [KEEP_TAB],
      hostNow: T0,
      hostAgentStatusTabIds: [KEEP_TAB],
      hostAgentStatusState: 'done'
    })
    applyHostSnapshot(store, done, T0)
    let previous = replayRetainedAgentsSync(store, new Map(), T0)
    const key = mirrorPaneKey(KEEP_TAB, KEEP_LEAF)
    expect(observeCurrentDisplay(store, T0)).toEqual({
      tabs: ['done'],
      sidebar: [key],
      workspace: 'done',
      dashboard: [key]
    })
    const launch = store.getState().agentLaunchConfigByPaneKey
    const recovery = store.getState().sleepingAgentSessionsByPaneKey
    const drop = vi.fn()
    vi.stubGlobal('window', { api: { agentStatus: { drop } } })
    try {
      const shell = makeShellSnapshot({
        snapshotVersion: 2,
        hostTabIds: [KEEP_TAB],
        hostNow: T0 + 1000
      })
      applyHostSnapshot(store, shell, T0 + 1000)
      expect(store.getState().retentionSuppressedPaneKeys[key]).toBe(true)
      previous = replayRetainedAgentsSync(store, previous, T0 + 1000)
      expect(observeCurrentDisplay(store, T0 + 1000)).toEqual({
        tabs: ['active'],
        sidebar: [],
        workspace: 'active',
        dashboard: []
      })
      applyHostSnapshot(store, { ...shell, snapshotVersion: 3 }, T0 + 2000, { expectChange: false })
      replayRetainedAgentsSync(store, previous, T0 + 2000)
      expect(store.getState().retainedAgentsByPaneKey).toEqual({})
      expect(observeCurrentDisplay(store, T0 + 2000).sidebar).toHaveLength(0)
      expect(store.getState().agentLaunchConfigByPaneKey).toBe(launch)
      expect(store.getState().sleepingAgentSessionsByPaneKey).toBe(recovery)
      expect(drop).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reconciles retained-only reconnect state atomically and preserves it until a current publication is accepted', () => {
    const store = seedPairedClientStore()
    const done = makeHostSnapshot({
      snapshotVersion: 2,
      hostTabIds: [KEEP_TAB],
      hostNow: T0,
      hostAgentStatusTabIds: [KEEP_TAB],
      hostAgentStatusState: 'done'
    })
    applyHostSnapshot(store, done, T0)
    const previous = replayRetainedAgentsSync(store, new Map(), T0)
    store.setState({ agentStatusByPaneKey: {} })
    replayRetainedAgentsSync(store, previous, T0)
    const retained = store.getState().retainedAgentsByPaneKey
    expect(observeCurrentDisplay(store, T0).sidebar).toHaveLength(1)
    // No accepted publication on disconnect/failure, and a superseded empty frame is rejected.
    applyHostSnapshot(store, { ...done, snapshotVersion: 1, tabs: [] }, T0 + 1000, {
      expectChange: false
    })
    expect(store.getState().retainedAgentsByPaneKey).toBe(retained)
    resetWebSessionTabsSnapshotFreshnessForTests()
    const shell = makeShellSnapshot({
      snapshotVersion: 3,
      hostTabIds: [KEEP_TAB],
      hostNow: T0 + 2000
    })
    const state = store.getState()
    const patch = applyFreshWebSessionTabsSnapshots(state, [shell], ENV, T0 + 2000)
    store.setState(patch as Partial<AppState>)
    replayRetainedAgentsSync(store, new Map(), T0 + 2000)
    expect(observeCurrentDisplay(store, T0 + 2000)).toEqual({
      tabs: ['active'],
      sidebar: [],
      workspace: 'active',
      dashboard: []
    })
  })

  it('a successor clears an unconsumed omission suppressor and rejects a delayed prior frame', () => {
    const store = seedPairedClientStore()
    const done = makeHostSnapshot({
      snapshotVersion: 1,
      hostTabIds: [KEEP_TAB],
      hostNow: T0,
      hostAgentStatusTabIds: [KEEP_TAB],
      hostAgentStatusState: 'done'
    })
    const key = mirrorPaneKey(KEEP_TAB, KEEP_LEAF)
    applyHostSnapshot(store, done, T0)
    const shell = makeShellSnapshot({
      snapshotVersion: 2,
      hostTabIds: [KEEP_TAB],
      hostNow: T0 + 1000
    })
    applyHostSnapshot(store, shell, T0 + 1000)
    expect(store.getState().retentionSuppressedPaneKeys[key]).toBe(true)
    const successor = makeHostSnapshot({
      snapshotVersion: 3,
      hostTabIds: [KEEP_TAB],
      hostNow: T0 + 2000,
      hostAgentStatusTabIds: [KEEP_TAB],
      hostAgentStatusState: 'done'
    })
    applyHostSnapshot(store, successor, T0 + 2000)
    expect(store.getState().retentionSuppressedPaneKeys[key]).toBeUndefined()
    const previous = replayRetainedAgentsSync(store, new Map(), T0 + 2000)
    applyHostSnapshot(store, shell, T0 + 3000, { expectChange: false })
    expect(store.getState().agentStatusByPaneKey[key]?.updatedAt).toBe(T0 + 2000)
    // A genuine later PTY exit still retains the successor's completion.
    store.getState().removeAgentStatus(key)
    replayRetainedAgentsSync(store, previous, T0 + 3000)
    expect(store.getState().retainedAgentsByPaneKey[key]?.entry.updatedAt).toBe(T0 + 2000)
  })

  it.each(['mirror-first', 'exit-first'] as const)(
    'preserves PTY-end history with %s callback order and a pending handle',
    (order) => {
      const store = seedPairedClientStore()
      const done = makeHostSnapshot({
        snapshotVersion: 1,
        hostTabIds: [KEEP_TAB],
        hostNow: T0,
        hostAgentStatusTabIds: [KEEP_TAB],
        hostAgentStatusState: 'done'
      })
      applyHostSnapshot(store, done, T0)
      const key = mirrorPaneKey(KEEP_TAB, KEEP_LEAF)
      const previous = replayRetainedAgentsSync(store, new Map(), T0)
      const pending: RuntimeMobileSessionTabsResult = {
        ...done,
        snapshotVersion: 2,
        tabs: done.tabs.map(({ agentStatus: _status, ...tab }) => ({
          ...tab,
          status: 'pending-handle',
          terminal: null
        }))
      }
      if (order === 'exit-first') {
        store.getState().removeAgentStatus(key)
      }
      applyHostSnapshot(store, pending, T0 + 1000, { expectChange: false })
      if (order === 'mirror-first') {
        store.getState().removeAgentStatus(key)
      }
      replayRetainedAgentsSync(store, previous, T0 + 1000)
      expect(store.getState().retentionSuppressedPaneKeys[key]).toBeUndefined()
      expect(store.getState().retainedAgentsByPaneKey[key]?.entry.state).toBe('done')
      expect(observeCurrentDisplay(store, T0 + 1000).workspace).toBe('done')
    }
  )

  it('preserves generic results, other hosts and a reused terminal handle while retiring only the matching agent', () => {
    const store = seedPairedClientStore()
    const done = makeHostSnapshot({
      snapshotVersion: 1,
      hostTabIds: [KEEP_TAB, RETRACTED_TAB],
      hostNow: T0,
      hostAgentStatusTabIds: [KEEP_TAB, RETRACTED_TAB],
      hostAgentStatusState: 'done'
    })
    applyHostSnapshot(store, done, T0)
    const key = mirrorPaneKey(KEEP_TAB, KEEP_LEAF)
    const other = mirrorPaneKey(RETRACTED_TAB, RETRACTED_LEAF)
    const live = store.getState().agentStatusByPaneKey
    const nativeKey = structuredAgentSessionPaneKey('native-tab', 'native-session')
    const native = {
      ...live[key]!,
      paneKey: nativeKey,
      tabId: 'native-tab',
      structuredHostOwned: true as const
    }
    store.setState({
      agentStatusByPaneKey: {
        ...live,
        [key]: { ...live[key]!, terminalHandle: 'successor-terminal' },
        [other]: { ...live[other]!, connectionId: 'another-host' },
        [nativeKey]: native
      }
    })
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 2,
        hostTabIds: [KEEP_TAB, RETRACTED_TAB],
        hostNow: T0 + 1000
      }),
      T0 + 1000,
      { expectChange: false }
    )
    expect(store.getState().agentStatusByPaneKey[key]?.terminalHandle).toBe('successor-terminal')
    expect(store.getState().agentStatusByPaneKey[other]?.connectionId).toBe('another-host')
    expect(store.getState().agentStatusByPaneKey[nativeKey]).toBe(native)
    const generic = {
      ...live[key]!,
      agentType: 'build',
      observation: {
        origin: 'osc' as const,
        authorityId: 'host',
        incarnation: 1,
        revision: 1,
        observedAt: T0
      }
    }
    store.setState({ agentStatusByPaneKey: { [key]: generic } })
    const previous = replayRetainedAgentsSync(store, new Map(), T0 + 1000)
    applyHostSnapshot(
      store,
      makeHostSnapshot({ snapshotVersion: 3, hostTabIds: [KEEP_TAB], hostNow: T0 + 2000 }),
      T0 + 2000
    )
    replayRetainedAgentsSync(store, previous, T0 + 2000)
    expect(store.getState().retainedAgentsByPaneKey[key]?.entry).toEqual(generic)
  })
}
