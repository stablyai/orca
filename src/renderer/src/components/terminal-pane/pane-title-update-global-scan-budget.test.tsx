// @vitest-environment happy-dom
/**
 * Deterministic, count-based reproduction for STA-7552 (under STA-7551).
 *
 * Zustand notifies every subscriber synchronously on every `set`, and each
 * subscriber re-runs its selector. A single pane title update therefore pays
 * for every mounted selector that rescans a global collection to conclude
 * nothing changed for it. `useShallow` suppresses the *re-render*, never the
 * selector body, so it does not help here.
 *
 * Scale is Jinjing's live 1.4.203-hourly capture: ~870 workspaces, ~1,400
 * terminal tabs, ~857 sleeping-agent records, ~177 agent-status rows, 20
 * mounted panes/cards.
 *
 * Scale check: this mount opens 5,500 zustand listeners, inside the capture's
 * 5,462-7,478. Most come from the sidebar — the worktree list is not
 * virtualised, so all 870 rows mount and each opens ~6 subscriptions.
 *
 * ONE `setRuntimePaneTitle` at that scale, before/after the park-exemption memo:
 *
 *   metric                                    before      after
 *   zustand listeners                          5,500      5,500
 *   store notifications                            1          1
 *   listener invocations                       5,500      5,500
 *   selector runs: worktree activity summary     896        896
 *   selector runs: worktree card status inputs 2,688      2,688
 *   selector runs: sleeping-record exemption      23         23
 *   sidebar rows committed (of 870)                1          1
 *   React commits: retained panes                  1          1
 *   sleeping-agent records read               19,711          0
 *   agent-status rows read                         0          0
 *   workspace tab buckets read                 1,394      2,081
 *
 * The current count also includes the later per-workspace sleep-state reader.
 *
 * So notification work is O(mounted workspaces) and this fix does not change
 * that — one shared store means every subscriber is visited. What changes is
 * the cost of each visit: the scan is gone, and 5,499 of the 5,500 invocations
 * were already resolving to "nothing changed for me" without re-rendering.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { selectTabBarAgentProjections } from '@/components/tab-bar/tab-agent-types-by-tab-id'
import { useWorktreeActivityStatus } from '@/components/sidebar/use-worktree-activity-status'
import { WorktreeCardStatusSlot } from '@/components/sidebar/WorktreeCardStatusSlot'
import { TooltipProvider } from '@/components/ui/tooltip'
import { readStoreListenerCount } from '@/store/store-listener-census'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'
// Why namespace type imports: vi.mock factories are hoisted, and `typeof import()`
// annotations are banned, so the module shapes come from erased type-only imports.
import type * as SleepingRecordParkExemptionModule from './sleeping-record-park-exemption'
import type * as WorktreeAgentActivitySummaryModule from '@/components/sidebar/worktree-agent-activity-summary'
import type * as WorktreeCardStatusInputsModule from '@/components/sidebar/worktree-card-status-inputs'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const WORKSPACE_COUNT = 870
const TERMINAL_TAB_COUNT = 1408
const SLEEPING_RECORD_COUNT = 857
const AGENT_STATUS_COUNT = 177
/** "Live or mounted panes: 20–28" in the capture. */
const MOUNTED_WORKTREE_COUNT = 20

const reads = { sleepingRecords: 0, agentStatusRows: 0, workspaceTabBuckets: 0 }

/** True per-module selector executions. Cached selectors read no records, so the
 *  scan counters alone cannot tell "never ran" from "ran and short-circuited". */
const selectorRuns = vi.hoisted(() => ({
  sleepingRecordParkExemption: 0,
  worktreeAgentActivitySummary: 0,
  worktreeCardStatusInputs: 0
}))

vi.mock('./sleeping-record-park-exemption', async (importOriginal) => {
  const actual = await importOriginal<typeof SleepingRecordParkExemptionModule>()
  return {
    ...actual,
    selectSleepingRecordParkExemptTabIds: (
      ...args: Parameters<typeof actual.selectSleepingRecordParkExemptTabIds>
    ) => {
      selectorRuns.sleepingRecordParkExemption += 1
      return actual.selectSleepingRecordParkExemptTabIds(...args)
    }
  }
})

vi.mock('@/components/sidebar/worktree-agent-activity-summary', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeAgentActivitySummaryModule>()
  return {
    ...actual,
    selectWorktreeAgentActivitySummary: (
      ...args: Parameters<typeof actual.selectWorktreeAgentActivitySummary>
    ) => {
      selectorRuns.worktreeAgentActivitySummary += 1
      return actual.selectWorktreeAgentActivitySummary(...args)
    }
  }
})

vi.mock('@/components/sidebar/worktree-card-status-inputs', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeCardStatusInputsModule>()
  const count = <TArgs extends unknown[], TResult>(
    select: (...args: TArgs) => TResult
  ): ((...args: TArgs) => TResult) => {
    return (...args: TArgs) => {
      selectorRuns.worktreeCardStatusInputs += 1
      return select(...args)
    }
  }
  return {
    ...actual,
    selectRuntimePaneTitlesForWorktree: count(actual.selectRuntimePaneTitlesForWorktree),
    selectLivePtyIdsForWorktree: count(actual.selectLivePtyIdsForWorktree),
    selectTerminalLayoutRootsForWorktree: count(actual.selectTerminalLayoutRootsForWorktree)
  }
})

/** Workspaces whose sidebar-row subtree committed. Why a `Profiler` and not a
 *  counter in the wrapper: `WorktreeCardStatusSlot` subscribes to the store
 *  itself, so it can commit without re-executing anything above it. */
const committedSidebarRows = new Set<string>()
/** React commits of the retained-pane hooks, which live in the probe body. */
const renders = { retainedPanes: 0 }
/** Store notifications; every live listener is visited on each one. */
let notifications = 0

/** Counts every value read, so a `for…in`/`Object.values` walk is visible without touching production code. */
function countingRecord<T>(
  entries: readonly (readonly [string, T])[],
  counter: keyof typeof reads
): Record<string, T> {
  const map: Record<string, T> = {}
  for (const [key, value] of entries) {
    Object.defineProperty(map, key, {
      enumerable: true,
      configurable: true,
      get: () => {
        reads[counter] += 1
        return value
      }
    })
  }
  return map
}

const worktreeIds = Array.from(
  { length: WORKSPACE_COUNT },
  (_, index) => `repo-1::/repo/wt-${index}`
)
const mountedWorktreeIds = worktreeIds.slice(0, MOUNTED_WORKTREE_COUNT)
/** The pane that receives the title update, on the first mounted workspace. */
const TARGET_WORKTREE_ID = mountedWorktreeIds[0]
const TARGET_TAB_ID = 'tab-0-0'
const TARGET_PANE_ID = 1

function buildTabsByWorktree(): Record<string, TerminalTab[]> {
  const tabsByWorktree: Record<string, TerminalTab[]> = {}
  let remaining = TERMINAL_TAB_COUNT
  for (const [index, worktreeId] of worktreeIds.entries()) {
    const count = Math.min(remaining, index < MOUNTED_WORKTREE_COUNT ? 4 : 2)
    remaining -= count
    tabsByWorktree[worktreeId] = Array.from({ length: count }, (_, tabIndex) => ({
      id: `tab-${index}-${tabIndex}`,
      ptyId: `${worktreeId}@@pty-${tabIndex}`,
      worktreeId,
      title: `tab ${tabIndex}`,
      customTitle: null,
      color: null,
      sortOrder: tabIndex,
      createdAt: 0
    }))
    if (remaining <= 0) {
      break
    }
  }
  return tabsByWorktree
}

const seededTabsByWorktree = buildTabsByWorktree()
const seededTerminalTabs = Object.values(seededTabsByWorktree).flat()
/** Counting view of the workspace inventory: one hit per bucket actually read,
 *  so "looked up my own workspace" and "walked all 870" are different numbers. */
const tabsByWorktree = countingRecord(Object.entries(seededTabsByWorktree), 'workspaceTabBuckets')

function buildSleepingRecords(): Record<string, SleepingAgentSessionRecord> {
  return countingRecord(
    Array.from({ length: SLEEPING_RECORD_COUNT }, (_, index) => {
      const worktreeId = worktreeIds[index % WORKSPACE_COUNT]
      const tabId = seededTabsByWorktree[worktreeId]?.[0]?.id ?? `tab-${index}-0`
      const paneKey = `${tabId}:1`
      const record: SleepingAgentSessionRecord = {
        paneKey,
        tabId,
        worktreeId,
        agent: 'claude',
        providerSession: { key: 'session_id', id: `session-${index}` },
        prompt: 'prompt',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1
      }
      return [paneKey, record] as const
    }),
    'sleepingRecords'
  )
}

function buildAgentStatuses(): Record<string, AgentStatusEntry> {
  const now = Date.now()
  return countingRecord(
    Array.from({ length: AGENT_STATUS_COUNT }, (_, index) => {
      const tabId = seededTerminalTabs[index % seededTerminalTabs.length].id
      const paneKey = `${tabId}:1`
      const entry: AgentStatusEntry = {
        paneKey,
        state: 'working',
        prompt: 'prompt',
        updatedAt: now,
        stateStartedAt: now,
        stateHistory: [],
        agentType: 'claude'
      }
      return [paneKey, entry] as const
    }),
    'agentStatusRows'
  )
}

const originalState = useAppStore.getState()
let container: HTMLDivElement | null = null
let root: Root | null = null

const EMPTY_ASSIGNMENTS = new Map<string, { groupId: string; isActiveInGroup: boolean }>()
const noop = (): void => {}
function recordSidebarRowCommit(worktreeId: string): void {
  committedSidebarRows.add(worktreeId)
}

/** The real sidebar row. `useWorktreeActivityStatus` opens ~6 store
 *  subscriptions per row, which is where the capture's thousands of listeners
 *  come from — the sidebar is not virtualised, so every workspace is mounted. */
function SidebarRowProbe({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  return (
    <React.Profiler id={worktreeId} onRender={recordSidebarRowCommit}>
      <WorktreeCardStatusSlot
        worktreeId={worktreeId}
        showStatus={true}
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="unread"
        onToggleUnread={noop}
        onPointerDown={noop}
      />
    </React.Profiler>
  )
}

/** The three consumers STA-7552 names, mounted per retained workspace. */
function MountedWorkspaceProbe({ worktreeId }: { worktreeId: string }): null {
  renders.retainedPanes += 1
  useTerminalTabColdParking({
    worktreeId,
    terminalTabs: seededTabsByWorktree[worktreeId] ?? [],
    assignments: EMPTY_ASSIGNMENTS,
    isWorktreeActive: worktreeId === TARGET_WORKTREE_ID,
    activeTerminalTabId: null,
    coldParkTerminalPanes: false,
    shouldMeasureHiddenWorktree: false,
    activityTerminalPortals: [],
    activationDeferredMountTabIds: null
  })
  useWorktreeActivityStatus(worktreeId)
  useAppStore(useShallow(selectTabBarAgentProjections))
  return null
}

function mountAtCaptureScale(): void {
  useAppStore.setState({
    tabsByWorktree,
    sleepingAgentSessionsByPaneKey: buildSleepingRecords(),
    agentStatusByPaneKey: buildAgentStatuses(),
    agentStatusEpoch: 1,
    activeWorktreeId: TARGET_WORKTREE_ID,
    runtimePaneTitlesByTabId: { [TARGET_TAB_ID]: { [TARGET_PANE_ID]: 'initial title' } }
  })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() =>
    root?.render(
      <TooltipProvider>
        {mountedWorktreeIds.map((worktreeId) => (
          <MountedWorkspaceProbe key={worktreeId} worktreeId={worktreeId} />
        ))}
        {worktreeIds.map((worktreeId) => (
          <SidebarRowProbe key={worktreeId} worktreeId={worktreeId} />
        ))}
      </TooltipProvider>
    )
  )
}

function liveListenerCount(): number {
  const count = readStoreListenerCount()
  if (count === null) {
    throw new Error('store listener census unavailable')
  }
  return count
}

function resetCounters(): void {
  reads.sleepingRecords = 0
  reads.agentStatusRows = 0
  reads.workspaceTabBuckets = 0
  committedSidebarRows.clear()
  renders.retainedPanes = 0
  notifications = 0
  selectorRuns.sleepingRecordParkExemption = 0
  selectorRuns.worktreeAgentActivitySummary = 0
  selectorRuns.worktreeCardStatusInputs = 0
}

function applyOnePaneTitleUpdate(title: string): void {
  act(() => {
    useAppStore.getState().setRuntimePaneTitle(TARGET_TAB_ID, TARGET_PANE_ID, title)
  })
}

let stopNotificationProbe: (() => void) | null = null

beforeEach(() => {
  resetCounters()
})

afterEach(() => {
  stopNotificationProbe?.()
  stopNotificationProbe = null
  if (root) {
    act(() => root?.unmount())
  }
  root = null
  container?.remove()
  container = null
  useAppStore.setState(originalState, true)
})

describe('one pane title update at live-capture scale', () => {
  it('still rescans when the sleeping-record inventory itself changes', () => {
    mountAtCaptureScale()
    reads.sleepingRecords = 0

    act(() => {
      useAppStore.setState({ sleepingAgentSessionsByPaneKey: buildSleepingRecords() })
    })

    // Why: correctness floor — a real inventory change must still be observed.
    expect(reads.sleepingRecords).toBeGreaterThanOrEqual(SLEEPING_RECORD_COUNT)
  })
})

describe('one pane title update: fanout at live-capture scale', () => {
  it('reports the four counts the ticket asks for', () => {
    mountAtCaptureScale()
    const listeners = liveListenerCount()
    resetCounters()
    stopNotificationProbe = useAppStore.subscribe(() => {
      notifications += 1
    })

    applyOnePaneTitleUpdate('next title')

    // The capture saw 5,462–7,478 listeners; this mount must be the same order,
    // and zustand visits every one of them on each notification.
    expect(listeners).toBeGreaterThan(5_000)
    expect(listeners).toBeLessThan(8_000)
    expect(notifications).toBe(1)

    // Every mounted subscriber's selector still runs. That is unchanged by this
    // fix and is inherent to one shared store: notification work stays
    // O(mounted workspaces), ~3,630 instrumented selector executions.
    expect(selectorRuns.worktreeAgentActivitySummary).toBeGreaterThanOrEqual(WORKSPACE_COUNT)
    expect(selectorRuns.worktreeCardStatusInputs).toBeGreaterThanOrEqual(WORKSPACE_COUNT * 3)
    expect(selectorRuns.sleepingRecordParkExemption).toBeGreaterThanOrEqual(MOUNTED_WORKTREE_COUNT)

    // …but every one of those executions is now an identity check. These three
    // counters sit on the state maps themselves, so they catch a walk by ANY of
    // the 5,500 subscribers, not only the three instrumented modules.
    expect(reads.sleepingRecords).toBe(0)
    expect(reads.agentStatusRows).toBe(0)
    // Activity status, card inputs, and sleep state each read their own bucket;
    // a global inventory scan per consumer would multiply this by 870.
    expect(reads.workspaceTabBuckets).toBeLessThan(WORKSPACE_COUNT * 3)

    // Only the workspace that owns the changed pane commits — the other 869
    // sidebar rows hold their identities and bail out.
    expect([...committedSidebarRows]).toEqual([TARGET_WORKTREE_ID])
    expect(renders.retainedPanes).toBeLessThanOrEqual(1)
  })

  it('stays flat across repeated updates', () => {
    mountAtCaptureScale()
    resetCounters()

    applyOnePaneTitleUpdate('title a')
    applyOnePaneTitleUpdate('title b')
    applyOnePaneTitleUpdate('title c')

    // Why repeat: one update could be served by a memo warmed at mount; three
    // prove the cost is independent of how many records the profile stores.
    expect(reads.sleepingRecords).toBe(0)
    expect(reads.agentStatusRows).toBe(0)
    expect([...committedSidebarRows]).toEqual([TARGET_WORKTREE_ID])
  })
})
