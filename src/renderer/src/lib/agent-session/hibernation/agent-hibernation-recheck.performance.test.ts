import { afterEach, expect, it, vi } from 'vitest'
import type * as TeardownOwner from '@/store/terminals/sleep/terminal-teardown-owner'

const work = vi.hoisted(() => {
  const counters: {
    statusReads: number
    tabReads: number
    ownerPtyReads: number
    ageCopies: number
    historyCopies: number
    planned: number
    ownerKind: 'non-runtime' | 'ambiguous'
    state: unknown
  } = {
    ownerKind: 'non-runtime',
    statusReads: 0,
    tabReads: 0,
    ownerPtyReads: 0,
    ageCopies: 0,
    historyCopies: 0,
    planned: 0,
    state: {}
  }
  return counters
})

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => work.state } }))
vi.mock('@/store/terminals/agent-pane-sleep-in-flight', () => ({
  trackAgentPaneSleep: (_paneKey: string, sleep: () => Promise<void>) => sleep()
}))
// Local panes: no runtime host to list, so evidence comes from this window's own terminals. An
// ambiguous owner (two hosts publish the workspace) is settled by the panes' own local PTY ids.
vi.mock('../../workspace/ownership/terminal-worktree-route', () => ({
  resolveTerminalPtyOwner: () => ({ kind: work.ownerKind })
}))
// The real owner conversion, counting the PTY ids each call walks.
vi.mock('@/store/terminals/sleep/terminal-teardown-owner', async (importOriginal) => {
  const real = await importOriginal<typeof TeardownOwner>()
  return {
    ...real,
    resolveTerminalTeardownOwner: (
      ...args: Parameters<typeof real.resolveTerminalTeardownOwner>
    ) => {
      work.ownerPtyReads += args[1].length
      return real.resolveTerminalTeardownOwner(...args)
    }
  }
})
vi.mock('../../pane-manager/mobile-driver-state', () => ({ getAllDrivers: () => new Map() }))
vi.mock('./agent-hibernation-output-activity', () => ({
  getAgentHibernationOutputSignature: () => 'quiet'
}))
vi.mock('../../terminal/input/terminal-input-activity-coalescing', () => ({
  mergePendingTerminalInputActivity: (stamps: unknown) => stamps
}))
vi.mock('../../window-activity/window-park-visibility', () => ({
  getWindowParkVisible: () => true,
  subscribeWindowParkVisibility: () => () => {}
}))
// Stands in for eligibility, counting the statuses and age entries each plan is handed.
vi.mock('./agent-hibernation-planner', () => ({
  getEffectiveAgentHibernationIdleMs: () => 60_000,
  planAgentHibernationCandidates: (snapshot: {
    tabsByWorktree: Record<string, { id: string }[]>
    agentStatusByPaneKey: { values(): Iterable<{ paneKey: string; tabId: string } | undefined> }
    ptyBindingFirstSeenAtByPaneKey: Record<string, number>
    boundaryResolvedAtByPaneKey: Record<string, number>
    foregroundTerminalLastSeenAtByTabId: Record<string, number>
  }) => {
    work.historyCopies += Object.keys(snapshot.foregroundTerminalLastSeenAtByTabId).length
    work.ageCopies +=
      Object.keys(snapshot.ptyBindingFirstSeenAtByPaneKey).length +
      Object.keys(snapshot.boundaryResolvedAtByPaneKey).length
    const candidates: unknown[] = []
    for (const [worktreeId, tabs] of Object.entries(snapshot.tabsByWorktree)) {
      const tabIds = new Set(tabs.map((tab) => tab.id))
      for (const entry of snapshot.agentStatusByPaneKey.values()) {
        work.planned += 1
        if (entry && tabIds.has(entry.tabId)) {
          candidates.push({
            id: `${worktreeId}|${entry.paneKey}`,
            worktreeId,
            paneKey: entry.paneKey,
            tabId: entry.tabId,
            leafId: 'leaf',
            paneKeys: [entry.paneKey],
            targetPtyIds: [`pty-${entry.tabId}`],
            expectedRuntimePtyIds: [],
            signature: 'idle'
          })
        }
      }
    }
    return candidates
  }
}))

import {
  runAgentHibernationTick,
  stopAgentHibernationCoordinator
} from './agent-hibernation-coordinator'
import { recordHibernationBoundaryResolved } from './agent-hibernation-pane-age'
import {
  forgetForegroundTerminalTabs,
  setForegroundTerminalTabIds
} from '../../../components/terminal-pane/parking/retention/foreground-terminal-tabs'

const LEAF_ID = '00000000-1111-4111-8111-111111111111'
type Status = { paneKey: string; tabId: string; state: 'done' }

/** The status index, counting every status the coordinator's producers read. */
function countedStatuses(entries: Map<string, Status>) {
  return {
    get(key: string): Status | undefined {
      work.statusReads += 1
      return entries.get(key)
    },
    *values(): Generator<Status> {
      for (const value of entries.values()) {
        work.statusReads += 1
        yield value
      }
    }
  }
}

afterEach(() => {
  stopAgentHibernationCoordinator()
  vi.unstubAllGlobals()
})

it.each([
  ['non-runtime', 100],
  ['non-runtime', 1_000],
  ['ambiguous', 100],
  ['ambiguous', 1_000]
] as const)(
  'each pane about to sleep re-checks only its own status, ages and tab (%s owner, %i idle panes in one workspace)',
  async (ownerKind, count) => {
    work.ownerKind = ownerKind
    vi.stubGlobal('window', { api: { pty: { getTerminalAttention: async () => ({}) } } })
    // Every walk over the workspace's tabs reads each tab's id.
    const tabs = Array.from({ length: count }, (_, index) => {
      const id = `${String(index).padStart(8, '0')}-2222-4222-8222-222222222222`
      return {
        get id() {
          work.tabReads += 1
          return id
        }
      }
    })
    const entries = new Map<string, Status>()
    for (const tab of tabs) {
      const paneKey = `${tab.id}:${LEAF_ID}`
      recordHibernationBoundaryResolved(paneKey, 1)
      entries.set(paneKey, { paneKey, tabId: tab.id, state: 'done' })
    }
    let slept = 0
    work.state = {
      settings: { agentHibernationIdleMs: 60_000 },
      tabsByWorktree: { wt: tabs },
      terminalLayoutsByTabId: Object.fromEntries(
        tabs.map((tab) => [tab.id, { ptyIdsByLeafId: { [LEAF_ID]: `pty-${tab.id}` } }])
      ),
      ptyIdsByTabId: Object.fromEntries(tabs.map((tab) => [tab.id, [`pty-${tab.id}`]])),
      agentStatusByPaneKey: countedStatuses(entries),
      sleepingAgentSessionsByPaneKey: {},
      lastTerminalInputAtByPaneKey: {},
      shutdownCompletedAgentPaneForHibernation: async (
        _worktreeId: string,
        options: { stillEligible: () => Promise<boolean> }
      ) => {
        if (await options.stillEligible()) {
          slept += 1
        }
      }
    }
    // The real foreground history: every tab the user has viewed, none of them in front now.
    const viewedTabIds = Array.from({ length: count }, (_, index) => `viewed-${index}`)
    setForegroundTerminalTabIds(viewedTabIds)
    setForegroundTerminalTabIds([])
    await runAgentHibernationTick()
    work.historyCopies = 0
    work.statusReads = 0
    work.tabReads = 0
    work.ownerPtyReads = 0
    work.ageCopies = 0
    work.planned = 0
    await runAgentHibernationTick()

    expect(slept).toBe(count)
    // The tick reads the fleet once for evidence and once to plan; each pane's two re-checks read only itself.
    const rechecks = 2 * count
    expect(work.statusReads).toBe(2 * count + 2 * rechecks)
    expect(work.planned).toBe(count + rechecks)
    expect(work.ageCopies).toBe(2 * count + 2 * rechecks)
    // The tick walks the workspace's tabs a few times; the re-checks share one index of them.
    expect(work.tabReads).toBeLessThanOrEqual(10 * count)
    // An ambiguous owner is settled from the workspace's PTYs once, not once per pane checked.
    expect(work.ownerPtyReads).toBeLessThanOrEqual(count)
    // The tick's plan copies the whole history once; a re-check reads at most its own tab's.
    expect(work.historyCopies).toBeLessThanOrEqual(count + rechecks)
    forgetForegroundTerminalTabs(viewedTabIds)
  }
)
