// @vitest-environment happy-dom
/** STA-7552: count selector reads at live-profile scale; Zustand invokes every selector on set, even when useShallow suppresses rendering. Global scans must stay absent. */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { selectTabBarAgentProjections } from '@/components/tab-bar/tab-agent-types-by-tab-id'
import { useWorktreeActivityStatus } from '@/components/sidebar/use-worktree-activity-status'
import { useWorktreeActivityStatuses } from '@/components/sidebar/use-worktree-activity-statuses'
import {
  PaletteLiveStatusProvider,
  PaletteWorktreeStatusDot
} from '@/components/cmd-j/palette-live-status'
import { WorktreeCardStatusSlot } from '@/components/sidebar/WorktreeCardStatusSlot'
import { TooltipProvider } from '@/components/ui/tooltip'
import { readStoreListenerCount } from '@/store/store-listener-census'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Tab } from '../../../../shared/tab-types'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'
// Hoisted mock factories need erased namespace types because typeof import() annotations are banned.
import type * as SleepingRecordParkExemptionModule from './sleeping-record-park-exemption'
import type * as WorktreeAgentActivitySummaryModule from '@/components/sidebar/worktree-agent-activity-summary'
import type * as WorktreeCardStatusInputsModule from '@/components/sidebar/worktree-card-status-inputs'
import type * as StructuredAgentSessionProjectionModule from '../../../../shared/structured-agent-session-projection'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const WORKSPACE_COUNT = 870
const TERMINAL_TAB_COUNT = 1408
const SLEEPING_RECORD_COUNT = 857
const AGENT_STATUS_COUNT = 177
/** "Live or mounted panes: 20–28" in the capture. */
const MOUNTED_WORKTREE_COUNT = 20

const reads = {
  sleepingRecords: 0,
  agentStatusRows: 0,
  workspaceTabBuckets: 0,
  chatTabBuckets: 0,
  chatTabs: 0
}
const chatWork = vi.hoisted(() => ({ hashes: 0 }))

vi.mock('../../../../shared/structured-agent-session-projection', async (importOriginal) => {
  const actual = await importOriginal<typeof StructuredAgentSessionProjectionModule>()
  return {
    ...actual,
    structuredAgentSessionPaneKey: (
      ...args: Parameters<typeof actual.structuredAgentSessionPaneKey>
    ) => {
      chatWork.hashes += 1
      return actual.structuredAgentSessionPaneKey(...args)
    }
  }
})

// Count selector executions separately from record reads so cache hits remain visible.
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

// Profile row subtrees because their store subscriptions can commit without rerunning the wrapper.
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
// Count bucket reads to distinguish per-workspace lookup from global inventory scans.
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

// Mount real unvirtualized sidebar rows to reproduce roughly six store subscriptions per workspace.
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
  reads.chatTabBuckets = 0
  reads.chatTabs = 0
  chatWork.hashes = 0
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
  vi.restoreAllMocks()
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

    // Match the captured listener scale; Zustand visits every listener on each notification.
    expect(listeners).toBeGreaterThan(5_000)
    expect(listeners).toBeLessThan(8_000)
    expect(notifications).toBe(1)

    // Shared-store notification still invokes every mounted selector.
    expect(selectorRuns.worktreeAgentActivitySummary).toBeGreaterThanOrEqual(WORKSPACE_COUNT)
    expect(selectorRuns.worktreeCardStatusInputs).toBeGreaterThanOrEqual(WORKSPACE_COUNT * 3)
    expect(selectorRuns.sleepingRecordParkExemption).toBeGreaterThanOrEqual(MOUNTED_WORKTREE_COUNT)

    // Map-level counters catch global walks by any subscriber, including uninstrumented modules.
    expect(reads.sleepingRecords).toBe(0)
    expect(reads.agentStatusRows).toBe(0)
    // Each consumer reads its own bucket; a global scan multiplies that cost by 870.
    expect(reads.workspaceTabBuckets).toBeLessThan(WORKSPACE_COUNT * 3)

    // Only the owning workspace commits; sibling row identities remain stable.
    expect([...committedSidebarRows]).toEqual([TARGET_WORKTREE_ID])
    expect(renders.retainedPanes).toBeLessThanOrEqual(1)
  })

  it('stays flat across repeated updates', () => {
    mountAtCaptureScale()
    resetCounters()

    applyOnePaneTitleUpdate('title a')
    applyOnePaneTitleUpdate('title b')
    applyOnePaneTitleUpdate('title c')

    // Repeat updates to rule out a mount-warmed memo hiding inventory-dependent cost.
    expect(reads.sleepingRecords).toBe(0)
    expect(reads.agentStatusRows).toBe(0)
    expect([...committedSidebarRows]).toEqual([TARGET_WORKTREE_ID])
  })
})

type ChatStatusConsumer = 'sidebar' | 'parent picker' | 'palette'

function ChatSidebarProbe({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  return <span data-chat-status>{useWorktreeActivityStatus(worktreeId)}</span>
}

function ChatParentPickerProbe({ ids }: { ids: readonly string[] }): React.JSX.Element {
  const statuses = useWorktreeActivityStatuses(ids)
  return (
    <>
      {ids.map((id) => (
        <span key={id} data-chat-status>
          {statuses.get(id)}
        </span>
      ))}
    </>
  )
}

function mountChatConsumers(
  consumer: ChatStatusConsumer,
  readerCount: number,
  tabsPerWorkspace: number
): void {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  useAppStore.setState(originalState, true)
  const sleptAtByPaneKey: Record<string, number | null> = {}
  const entries = worktreeIds.map((worktreeId, workspaceIndex) => {
    const tabs: Tab[] = []
    // Keep offscreen buckets populated to expose a whole-store scan in any mounted reader.
    const count = workspaceIndex < readerCount ? tabsPerWorkspace : 1
    for (let index = 0; index < count; index += 1) {
      const tab: Tab = {
        id: `chat-${workspaceIndex}-${index}`,
        entityId: `session-${workspaceIndex}-${index}`,
        worktreeId,
        groupId: 'group-1',
        contentType: 'agent-session',
        agentSessionAgent: 'codex',
        label: 'Codex',
        customLabel: null,
        color: null,
        sortOrder: index,
        createdAt: 0
      }
      // All slept forces a full local scan, rather than a first-awake-tab short circuit.
      sleptAtByPaneKey[structuredAgentSessionPaneKey(tab.id, tab.entityId)] = 1
      Object.defineProperty(tabs, index, {
        enumerable: true,
        get: () => {
          reads.chatTabs += 1
          return tab
        }
      })
    }
    return [worktreeId, tabs] as const
  })
  useAppStore.setState({
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    unifiedTabsByWorktree: countingRecord(entries, 'chatTabBuckets'),
    structuredChatSleptAtByPaneKey: sleptAtByPaneKey,
    runtimePaneTitlesByTabId: { [TARGET_TAB_ID]: { [TARGET_PANE_ID]: 'initial title' } }
  })
  const ids = worktreeIds.slice(0, readerCount)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const content =
    consumer === 'parent picker' ? (
      <ChatParentPickerProbe ids={ids} />
    ) : consumer === 'sidebar' ? (
      ids.map((id) => <ChatSidebarProbe key={id} worktreeId={id} />)
    ) : (
      <PaletteLiveStatusProvider active>
        {ids.map((id) => (
          <span key={id} data-chat-status>
            <PaletteWorktreeStatusDot worktree={{ id }} />
          </span>
        ))}
      </PaletteLiveStatusProvider>
    )
  act(() => root?.render(<TooltipProvider>{content}</TooltipProvider>))
}

function chatStatusLabels(): string[] {
  return Array.from(
    container?.querySelectorAll('[data-chat-status]') ?? [],
    (node) => node.textContent?.trim().toLowerCase() ?? ''
  )
}

function measureChatTitleUpdate(): { buckets: number; tabs: number; hashes: number } {
  resetCounters()
  const stop = useAppStore.subscribe(() => {
    notifications += 1
  })
  try {
    applyOnePaneTitleUpdate('next unrelated title')
    expect(notifications).toBe(1)
    return { buckets: reads.chatTabBuckets, tabs: reads.chatTabs, hashes: chatWork.hashes }
  } finally {
    stop()
  }
}

describe.each<ChatStatusConsumer>(['sidebar', 'parent picker', 'palette'])(
  '%s chat-only status subscriptions',
  (consumer) => {
    it.each(['tabs', 'readers'] as const)(
      'bounds %s work at N and 10N on real title writes',
      (axis) => {
        const samples = [1, 10].map((scale) => {
          const readerCount = axis === 'readers' ? 87 * scale : MOUNTED_WORKTREE_COUNT
          const tabsPerWorkspace = axis === 'tabs' ? 10 * scale : 2
          mountChatConsumers(consumer, readerCount, tabsPerWorkspace)
          expect(chatStatusLabels()).toEqual(Array(readerCount).fill('inactive'))
          expect(chatWork.hashes).toBeGreaterThan(0)
          const measured = measureChatTitleUpdate()
          // Allow React snapshot checks/context renders; never an inventory scan per row.
          expect(measured.buckets).toBeLessThanOrEqual(readerCount * 6)
          expect(measured.tabs).toBeLessThanOrEqual(readerCount * tabsPerWorkspace * 6)
          expect(measured.hashes).toBeLessThanOrEqual(readerCount * tabsPerWorkspace * 6)
          return measured
        })
        for (const operation of ['buckets', 'tabs', 'hashes'] as const) {
          expect(samples[1][operation]).toBeLessThanOrEqual(Math.max(1, samples[0][operation]) * 10)
        }
      }
    )

    it('observes chat evidence live while preserving agent priority', () => {
      const now = 1_000
      vi.spyOn(Date, 'now').mockReturnValue(now)
      mountChatConsumers(consumer, 1, 1)
      expect(chatStatusLabels()).toEqual(['inactive'])
      const tab = useAppStore.getState().unifiedTabsByWorktree[TARGET_WORKTREE_ID][0]
      const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
      act(() => useAppStore.getState().setStructuredChatSleptAt(paneKey, undefined))
      expect(chatStatusLabels()).toEqual(['active'])
      act(() => useAppStore.getState().setStructuredChatSleptAt(paneKey, 1))
      expect(chatStatusLabels()).toEqual(['inactive'])
      act(() => useAppStore.getState().setStructuredChatSleptAt(paneKey, null))
      expect(chatStatusLabels()).toEqual(['active'])
      const working: AgentStatusEntry = {
        paneKey,
        worktreeId: TARGET_WORKTREE_ID,
        state: 'working',
        prompt: '',
        updatedAt: now,
        stateStartedAt: now,
        stateHistory: []
      }
      act(() =>
        useAppStore.setState({ agentStatusByPaneKey: { [paneKey]: working }, agentStatusEpoch: 1 })
      )
      expect(chatStatusLabels()).toEqual(['working'])
      if (consumer !== 'palette') {
        act(() =>
          useAppStore.setState({
            agentStatusByPaneKey: { [paneKey]: { ...working, state: 'done' } },
            agentStatusEpoch: 2
          })
        )
        expect(chatStatusLabels()).toEqual(['done'])
      }
      act(() =>
        useAppStore.setState({
          unifiedTabsByWorktree: {},
          agentStatusByPaneKey: {},
          agentStatusEpoch: 3
        })
      )
      expect(chatStatusLabels()).toEqual(['inactive'])
    })
  }
)
