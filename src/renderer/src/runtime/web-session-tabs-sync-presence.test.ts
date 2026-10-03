import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  applyWebSessionTabsSnapshot,
  shouldApplyWebSessionTabsSnapshot
} from './web-session-tabs-sync'
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
vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))
const presence = {
  agent: 'claude',
  process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
} as const
const relaunchedProcess = { pid: 43, platform: 'linux', startTime: 'boot:43' } as const
function snapshot(
  ended: boolean,
  row: Partial<AgentStatusEntry> = {},
  version?: number,
  surfaces = true
) {
  return makeSnapshot(
    surfaces
      ? [
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            title: 'zsh',
            launchAgent: 'claude',
            isActive: true,
            status: 'ready',
            terminal: 'terminal-1',
            agentStatus: {
              state: 'done',
              prompt: '',
              updatedAt: 10,
              stateStartedAt: 10,
              paneKey: makePaneKey('host-tab-1', LEAF_ID),
              agentType: 'claude',
              stateHistory: [],
              agentPresence: { ...presence, ...(ended ? { ended: true } : {}) },
              ...row
            }
          }
        ]
      : [],
    version === undefined
      ? {}
      : { snapshotVersion: version, ...(surfaces ? {} : { activeTabId: null }) }
  )
}
describe('paired host presence', () => {
  beforeEach(resetWebSessionTabsSyncTestState)
  it('keeps host evidence clocks and applies an exit independently of client turn clocks', () => {
    const state = makeState()
    const first = applyWebSessionTabsSnapshot(state, snapshot(false), ENV, NOW)
    expect(first?.agentPresenceByPaneKey).toBeDefined()
    const paneKey = Object.keys(first?.agentPresenceByPaneKey ?? {})[0]
    expect(first?.agentPresenceByPaneKey?.[paneKey]).toMatchObject({
      presence,
      receivedAt: 10,
      connectionId: ENV
    })
    const mirrored = { ...state, ...first }
    const turn = mirrored.agentStatusByPaneKey[paneKey]
    mirrored.agentStatusByPaneKey = {
      ...mirrored.agentStatusByPaneKey,
      [paneKey]: { ...turn, state: 'working', updatedAt: NOW + 99999 }
    }
    const next = applyWebSessionTabsSnapshot(mirrored, snapshot(true), ENV, NOW + 1)
    expect(next?.agentPresenceByPaneKey?.[paneKey]?.presence.ended).toBe(true)
    expect(next?.agentStatusByPaneKey?.[paneKey]).toBeUndefined()
    expect(next?.tabsByWorktree?.[WT] ?? mirrored.tabsByWorktree[WT]).toHaveLength(1)
  })

  it('drops an ended owner when a newer host row no longer carries a process', () => {
    const state = makeState()
    const ended = { ...state, ...applyWebSessionTabsSnapshot(state, snapshot(true), ENV, NOW) }
    const paneKey = Object.keys(ended.agentPresenceByPaneKey ?? {})[0]
    expect(ended.agentPresenceByPaneKey?.[paneKey]?.presence.ended).toBe(true)
    // A later agent the host cannot identify (for example Codex) publishes only a legacy row.
    const successor: Partial<AgentStatusEntry> = {
      state: 'working',
      prompt: 'refactor',
      updatedAt: 20,
      stateStartedAt: 20,
      agentType: 'codex',
      agentPresence: undefined
    }
    const next = {
      ...ended,
      ...applyWebSessionTabsSnapshot(ended, snapshot(false, successor, 2), ENV, NOW + 1)
    }
    expect(next.agentPresenceByPaneKey?.[paneKey]).toBeUndefined()
    expect(next.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'working',
      agentType: 'codex'
    })
  })

  it('does not resurrect an ended owner from an older live snapshot', () => {
    // Snapshot order, not the status clock, decides: an older version never reaches the mirror.
    const ended = snapshot(true, {}, 2)
    expect(shouldApplyWebSessionTabsSnapshot(ended, ENV)).toBe(true)
    expect(shouldApplyWebSessionTabsSnapshot(snapshot(false, {}, 1), ENV)).toBe(false)
  })

  it('takes each newer snapshot owner even when its status clock is older', () => {
    const state = makeState()
    // Case A: a live owner first seen at 1000, then its exit published on a status stamped 400.
    const live = {
      ...state,
      ...applyWebSessionTabsSnapshot(state, snapshot(false, { updatedAt: 1000 }), ENV, NOW)
    }
    const paneKey = Object.keys(live.agentPresenceByPaneKey ?? {})[0]
    const exited = {
      ...live,
      ...applyWebSessionTabsSnapshot(live, snapshot(true, { updatedAt: 400 }, 2), ENV, NOW + 1)
    }
    expect(exited.agentPresenceByPaneKey?.[paneKey]?.presence.ended).toBe(true)
    expect(exited.agentStatusByPaneKey[paneKey]).toBeUndefined()
    // Case C: a relaunched Claude (new process) published on an older status clock.
    const relaunched = {
      ...exited,
      ...applyWebSessionTabsSnapshot(
        exited,
        snapshot(
          false,
          { updatedAt: 300, agentPresence: { agent: 'claude', process: relaunchedProcess } },
          3
        ),
        ENV,
        NOW + 2
      )
    }
    expect(relaunched.agentPresenceByPaneKey?.[paneKey]?.presence).toEqual({
      agent: 'claude',
      process: relaunchedProcess
    })
    expect(relaunched.agentStatusByPaneKey[paneKey]).toBeDefined()
  })

  it('keeps a later agent status in the pane after the owner exited', () => {
    // Case B: a hookless successor publishes under the retained exited owner record.
    const state = makeState()
    const next = {
      ...state,
      ...applyWebSessionTabsSnapshot(
        state,
        snapshot(true, { state: 'working', prompt: 'refactor', agentType: 'aider' }),
        ENV,
        NOW
      )
    }
    const paneKey = Object.keys(next.agentPresenceByPaneKey ?? {})[0]
    expect(next.agentPresenceByPaneKey?.[paneKey]?.presence.ended).toBe(true)
    expect(next.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'working',
      agentType: 'aider'
    })
  })

  it('releases mirrored presence when the host retracts the terminal', () => {
    const state = makeState()
    const live = { ...state, ...applyWebSessionTabsSnapshot(state, snapshot(false), ENV, NOW) }
    const paneKey = Object.keys(live.agentPresenceByPaneKey ?? {})[0]
    expect(live.agentPresenceByPaneKey?.[paneKey]?.presence.process).toBeDefined()
    const retracted = applyWebSessionTabsSnapshot(live, snapshot(false, {}, 2, false), ENV, NOW + 1)
    const next = { ...live, ...retracted }
    expect(Object.values(next.tabsByWorktree).flat()).toHaveLength(0)
    expect(next.agentPresenceByPaneKey?.[paneKey]).toBeUndefined()
  })

  it('keeps a host-local row local and leaves unidentified attribution to the host', () => {
    const state = makeState()
    const mirror = (row: Partial<AgentStatusEntry>) => {
      const next = {
        ...state,
        ...applyWebSessionTabsSnapshot(state, snapshot(false, row), ENV, NOW)
      }
      return Object.values(next.agentStatusByPaneKey)[0]
    }
    expect(mirror({ connectionId: null })).toMatchObject({ connectionId: null, worktreeId: WT })
    const unidentified = mirror({ connectionId: null, agentPresence: undefined })
    expect(unidentified?.connectionId).toBeNull()
    expect(unidentified?.worktreeId).toBeUndefined()
  })

  it('releases a live owner when a newer snapshot shows the pane without status', () => {
    const state = makeState()
    const live = { ...state, ...applyWebSessionTabsSnapshot(state, snapshot(false), ENV, NOW) }
    const paneKey = Object.keys(live.agentPresenceByPaneKey ?? {})[0]
    expect(live.agentPresenceByPaneKey?.[paneKey]?.presence.process).toBeDefined()
    const bare = snapshot(false, {}, 2)
    const tab = bare.tabs[0]
    if (tab?.type !== 'terminal') {
      throw new Error('missing terminal')
    }
    const { agentStatus: _dropped, ...withoutStatus } = tab
    const next = {
      ...live,
      ...applyWebSessionTabsSnapshot(live, { ...bare, tabs: [withoutStatus] }, ENV, NOW + 1)
    }
    expect(next.agentPresenceByPaneKey?.[paneKey]).toBeUndefined()
  })

  it('does not republish presence for a status ping from the same owner', () => {
    const state = makeState()
    const live = { ...state, ...applyWebSessionTabsSnapshot(state, snapshot(false), ENV, NOW) }
    const ping = { updatedAt: 20, prompt: 'next', state: 'working' } as const
    const next = applyWebSessionTabsSnapshot(live, snapshot(false, ping, 2), ENV, NOW + 1)
    expect(next).not.toBeNull()
    expect(next).not.toHaveProperty('agentPresenceByPaneKey')
  })
})
