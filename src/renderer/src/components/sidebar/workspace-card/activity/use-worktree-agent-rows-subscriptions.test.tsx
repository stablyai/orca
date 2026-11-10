import * as tabOwners from './tab-worktree-owner-index'
import type { TerminalLayoutSnapshot } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { useAllAgentPaneThreadStoreData } from '@/components/activity/use-agent-pane-thread-store-data'
import { buildActivityEvents } from '@/components/activity/activity-event-builder'
import * as paneProjection from '../../../../../../shared/agent-session/lifecycle/pane-sleep-agent-status'
import * as activityContext from '@/components/activity/activity-event-builder-context'
import * as activityBuildCache from '@/components/activity/activity-event-build-cache'
import { unoccupiedSleptAgentStatusByPaneKey } from './worktree-unoccupied-slept-agent-index'
import { selectWorktreeAgentActivitySummary } from './worktree-agent-activity-summary'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
// @vitest-environment happy-dom
import { act, useMemo, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import type { AppState } from '@/store/types'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { OwnedPaneAgentRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { replaceTabBuckets, replaceRecordEntries } from '@/store/keyed-record-transitions'
import {
  sleptAgentStatusByPaneKey,
  sleptAgentEntriesByWorktree
} from './worktree-slept-agent-index'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const LEAF = '11111111-1111-4111-8111-111111111111'
const KEY_A = makePaneKey('tab-a', LEAF)
const KEY_B = makePaneKey('tab-b', LEAF)
const original = useAppStore.getState()
let root: Root
let container: HTMLDivElement
let rows: DashboardAgentRow[]
const renders = new Map<string, number>()
const summaryRenders = new Map<string, number>()
const observedRows = new Map<string, DashboardAgentRow[]>()

function Probe({
  worktreeId = 'folder-a',
  active = true
}: {
  worktreeId?: string
  active?: boolean
}) {
  rows = useWorktreeAgentRows(worktreeId, active)
  renders.set(worktreeId, (renders.get(worktreeId) ?? 0) + 1)
  observedRows.set(worktreeId, rows)
  return null
}
function entry(key: string, worktreeId: string): AgentStatusEntry {
  return {
    paneKey: key,
    worktreeId,
    state: 'working',
    agentType: 'claude',
    prompt: worktreeId,
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    stateHistory: []
  }
}
function patch(update: Partial<AppState>) {
  act(() => useAppStore.setState(update))
}

beforeEach(() => {
  renders.clear()
  summaryRenders.clear()
  observedRows.clear()
  vi.useFakeTimers()
  vi.setSystemTime(2_000_000)
  useAppStore.setState({
    tabsByWorktree: {
      'folder-a': [makeTab({ id: 'tab-a', worktreeId: 'folder-a' })],
      'ssh-b': [makeTab({ id: 'tab-b', worktreeId: 'ssh-b' })]
    },
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {
      [KEY_A]: entry(KEY_A, 'folder-a'),
      [KEY_B]: { ...entry(KEY_B, 'ssh-b'), connectionId: 'ssh:host' }
    },

    migrationUnsupportedByPtyId: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    refreshGitHubForWorktreeIfStale: vi.fn(),
    paneForegroundAgentByPaneKey: {}
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.setState(original, true)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('mounted worktree agent row subscriptions', () => {
  it('switches worktrees and applies an SSH status update immediately', () => {
    act(() => root.render(<Probe />))
    act(() => root.render(<Probe worktreeId="ssh-b" />))
    expect(rows[0].paneKey).toBe(KEY_B)
    act(() =>
      useAppStore
        .getState()
        .setAgentStatus(
          KEY_B,
          { state: 'blocked', agentType: 'claude', prompt: 'remote permission' },
          undefined,
          { updatedAt: Date.now() + 1 },
          { tabId: 'tab-b', worktreeId: 'ssh-b', connectionId: 'ssh:host' }
        )
    )
    expect(rows[0].entry.prompt).toBe('remote permission')
    expect(rows[0].state).toBe('blocked')
  })

  it('decays on an epoch-only freshness tick', () => {
    act(() => root.render(<Probe />))
    expect(rows[0].state).toBe('working')
    vi.setSystemTime(Date.now() + AGENT_STATUS_STALE_AFTER_MS + 1)
    patch({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 })
    expect(rows[0].state).toBe('idle')
  })
})

it.each([100, 1000])(
  'keeps unrelated sleep candidates and mounted rows untouched at %i workspaces',
  (size) => {
    let sourceReads = 0
    const tabsByWorktree: AppState['tabsByWorktree'] = {}
    const agentStatusByPaneKey: AppState['agentStatusByPaneKey'] = {}
    const records: Record<string, OwnedPaneAgentRecord> = {}
    for (let i = 0; i < size; i++) {
      const worktreeId = `fleet-${i}`
      const tabId = `fleet-tab-${i}`
      const paneKey = makePaneKey(tabId, LEAF)
      tabsByWorktree[worktreeId] = [makeTab({ id: tabId, worktreeId })]
      if (i < 100) {
        agentStatusByPaneKey[paneKey] = entry(paneKey, worktreeId)
      }
      records[paneKey] = {
        paneKey,
        tabId,
        worktreeId,
        agent: 'claude',
        providerSession: { key: 'session_id', id: `session-${i}` },
        prompt: worktreeId,
        state: 'working',
        capturedAt: 1000,
        updatedAt: 1000,
        get origin() {
          sourceReads++
          return 'live' as const
        }
      }
    }
    patch({ tabsByWorktree, agentStatusByPaneKey, sleepingAgentSessionsByPaneKey: records })
    act(() =>
      root.render(
        <>
          {Object.keys(tabsByWorktree).map((worktreeId) => (
            <Probe key={worktreeId} worktreeId={worktreeId} />
          ))}
        </>
      )
    )
    renders.clear()
    sourceReads = 0
    // A live record has no sleeping display output, so one addressed change may inspect only that candidate.
    const paneKey = makePaneKey('fleet-tab-0', LEAF)
    const record = records[paneKey]
    if (record.kind === 'display-only') {
      throw new Error('Expected live checkpoint')
    }
    patch({
      sleepingAgentSessionsByPaneKey: replaceRecordEntries<OwnedPaneAgentRecord>(records, [
        [paneKey, { ...record, updatedAt: 1001 }]
      ])
    })
    expect(sourceReads).toBeLessThanOrEqual(2)
    expect([...renders.values()].reduce((sum, count) => sum + count, 0)).toBe(0)
    // A genuine other-host status update changes exactly its row; local rows stay stable.
    act(() =>
      useAppStore
        .getState()
        .setAgentStatus(
          paneKey,
          { state: 'blocked', agentType: 'claude', prompt: 'permission on other host' },
          undefined,
          { updatedAt: Date.now() + 1 },
          { worktreeId: 'fleet-0', tabId: 'fleet-tab-0', connectionId: 'other-host' }
        )
    )
    expect(observedRows.get('fleet-0')?.[0].state).toBe('blocked')
    expect([...renders.keys()]).toEqual(['fleet-0'])
    // Layout changes need only sleeping candidates, never all the live/quit resume records.
    sourceReads = 0
    sleptAgentEntriesByWorktree({ ...useAppStore.getState(), terminalLayoutsByTabId: {} })
    expect(sourceReads).toBe(0)
  }
)

const names = new Map()
let passiveCount = 0
function SummaryProbe({ worktreeId }: { worktreeId: string }) {
  useAppStore((state) => selectWorktreeAgentActivitySummary(state, worktreeId))
  summaryRenders.set(worktreeId, (summaryRenders.get(worktreeId) ?? 0) + 1)
  return null
}
function ActivityProbe() {
  const data = useAllAgentPaneThreadStoreData()
  const cache = useRef(activityBuildCache.createActivityEventBuildCache())
  const result = useMemo(
    () =>
      buildActivityEvents(
        {
          chatNames: names,
          agentStatusByPaneKey: data.agentStatusByPaneKey,
          sleepingAgentStatusByPaneKey: data.sleepingAgentStatusByPaneKey,
          runtimeAgentOrchestrationByPaneKey: data.runtimeAgentOrchestrationByPaneKey,
          tabsByWorktree: data.tabsByWorktree,
          unifiedTabsByWorktree: data.activityTabs,
          worktreeMap: data.worktreeMap,
          repoMap: data.repoMap,
          repos: data.repos,
          resolveWorktree: data.getKnownWorktreeById,
          ownerCatalog: [
            data.worktreesByRepo,
            data.detectedWorktreesByRepo,
            data.folderWorkspaces,
            data.projectGroups,
            data.floatingWorkspacePath
          ],
          acknowledgedAgentsByPaneKey: data.acknowledgedAgentsByPaneKey,
          activityClearedAtByPaneKey: data.activityClearedAtByPaneKey,
          now: 2_000_000
        },
        cache.current
      ),
    [data]
  )
  passiveCount = Object.keys(result.passiveAgentByPaneKey).length
  return null
}

it.each([100, 1000])(
  'addresses actual sleeping rows at %i workspaces without fleet sleep work',
  (size) => {
    const project = vi.spyOn(paneProjection, 'paneSleepAgentStatus')
    const paneBuild = vi.spyOn(activityBuildCache, 'resolvePaneBuild')
    const owners = vi.spyOn(activityContext, 'resolveActivityEventOwner')
    const ownerProbes = vi.spyOn(activityContext, 'selectActivityEventOwner')
    const ownerRequests = vi.spyOn(tabOwners, 'getTabIdToWorktreeId')
    const touchedRecords = new Set<string>()
    let recordReads = 0
    let treeReads = 0
    let indexReferenceSlots = 0
    let outputReferenceSlots = 0
    let watchedPoints: ReadonlyMap<string, AgentStatusEntry> | undefined
    let watchedBuckets: Map<string, AgentStatusEntry[]> | undefined
    let watchedOutput: ReadonlyMap<string, AgentStatusEntry> | undefined
    // Partial iterator counter: native Map copies are accounted separately from source (at most four S-sized containers on a structural edit).
    const iterate = Map.prototype[Symbol.iterator]
    vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
      this: Map<unknown, unknown>
    ) {
      const iterator = iterate.call(this)
      const next = iterator.next.bind(iterator)
      iterator.next = (...args) => {
        const item = next(...args)
        if (!item.done) {
          if (this === watchedPoints || this === watchedBuckets) {
            indexReferenceSlots++
          }
          if (this === watchedOutput) {
            outputReferenceSlots++
          }
        }
        return item
      }
      return iterator
    })
    const walkedTrees = new Set<string>()
    const records: Record<string, OwnedPaneAgentRecord> = {}
    const tabs: AppState['tabsByWorktree'] = {}
    const layouts: AppState['terminalLayoutsByTabId'] = {}
    const live: AppState['agentStatusByPaneKey'] = {}
    const sleepCount = size / 2
    const sleepKey = (i: number) => makePaneKey(`asleep-${i}`, LEAF)
    const sleepRecord = (i: number, prompt = 'sleeping task'): OwnedPaneAgentRecord => {
      const paneKey = sleepKey(i)
      const worktreeId = `fleet-${i}`
      const common = {
        paneKey,
        tabId: `asleep-${i}`,
        worktreeId,
        capturedAt: 1_500,
        connectionId: null,
        get origin() {
          touchedRecords.add(paneKey)
          recordReads++
          return 'worktree-sleep' as const
        }
      }
      return i % 2 === 0
        ? {
            ...common,
            get origin() {
              touchedRecords.add(paneKey)
              recordReads++
              return 'worktree-sleep' as const
            },
            kind: 'display-only',
            completion: { kind: 'current' },
            display: {
              state: 'done',
              agentType: 'claude',
              prompt,
              updatedAt: 1_000,
              stateStartedAt: 1_000
            }
          }
        : {
            ...common,
            get origin() {
              touchedRecords.add(paneKey)
              recordReads++
              return 'worktree-sleep' as const
            },
            agent: 'codex',
            providerSession: { key: 'session_id', id: `session-${i}` },
            state: 'done',
            prompt,
            updatedAt: 1_000,
            stateStartedAt: 1_000,
            completion: { kind: 'passive' }
          }
    }
    for (let i = 0; i < size; i++) {
      const worktreeId = `fleet-${i}`
      const tabId = `awake-${i}`
      tabs[worktreeId] = [makeTab({ id: tabId, worktreeId })]
      if (i < 100) {
        live[makePaneKey(tabId, LEAF)] = entry(makePaneKey(tabId, LEAF), worktreeId)
      }
      layouts[tabId] = {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      }
      if (i < sleepCount) {
        tabs[worktreeId].push(makeTab({ id: `asleep-${i}`, worktreeId }))
        records[sleepKey(i)] = sleepRecord(i)
        layouts[`asleep-${i}`] = {
          root: {
            type: 'leaf',
            get leafId() {
              walkedTrees.add(`asleep-${i}`)
              treeReads++
              return LEAF
            }
          },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    }
    patch({
      tabsByWorktree: tabs,
      terminalLayoutsByTabId: layouts,
      agentStatusByPaneKey: live,
      sleepingAgentSessionsByPaneKey: records,
      repos: [TEST_REPO],
      worktreesByRepo: {
        [TEST_REPO.id]: Object.keys(tabs).map((id) =>
          makeWorktree({ id, repoId: TEST_REPO.id, hostId: 'local' })
        )
      }
    })
    act(() =>
      root.render(
        <>
          <ActivityProbe />
          {Object.keys(tabs).map((id) => (
            <div key={id}>
              <Probe worktreeId={id} />
              <SummaryProbe worktreeId={id} />
            </div>
          ))}
        </>
      )
    )
    expect(passiveCount).toBe(sleepCount)
    expect(
      observedRows
        .get('fleet-0')
        ?.map((row) => row.state)
        .toSorted()
    ).toEqual(['done', 'working'])
    const reset = () => {
      renders.clear()
      summaryRenders.clear()
      project.mockClear()
      paneBuild.mockClear()
      owners.mockClear()
      ownerProbes.mockClear()
      ownerRequests.mockClear()
      recordReads = 0
      treeReads = 0
      indexReferenceSlots = 0
      outputReferenceSlots = 0
      watchedPoints = sleptAgentStatusByPaneKey(useAppStore.getState())
      watchedBuckets = sleptAgentEntriesByWorktree(useAppStore.getState())
      watchedOutput = unoccupiedSleptAgentStatusByPaneKey(useAppStore.getState())
      touchedRecords.clear()
      walkedTrees.clear()
    }
    const transition = () =>
      act(() =>
        useAppStore
          .getState()
          .setAgentStatus(
            makePaneKey('awake-0', LEAF),
            { state: 'done', prompt: 'finished now', agentType: 'claude' },
            undefined,
            { updatedAt: Date.now() + 1 },
            { worktreeId: 'fleet-0', tabId: 'awake-0', connectionId: null }
          )
      )
    reset()
    transition()
    expect([...touchedRecords]).toEqual([])
    expect([...walkedTrees]).toEqual([])
    expect([...renders.keys()]).toEqual(['fleet-0'])
    expect([...summaryRenders.keys()]).toEqual(['fleet-0'])
    expect(project).not.toHaveBeenCalled()
    expect(recordReads).toBe(0)
    expect(treeReads).toBe(0)
    expect(indexReferenceSlots).toBe(0)
    // A complete list enumerates its visible cached outputs, without rebuilding sleeping events.
    expect(outputReferenceSlots).toBe(sleepCount)
    expect(
      paneBuild.mock.calls.filter(([input]) => input.cacheKey.startsWith('sleep:'))
    ).toHaveLength(0)
    expect(observedRows.get('fleet-0')?.map((row) => row.state)).toEqual(['done', 'done'])
    reset()
    transition()
    expect([...touchedRecords]).toEqual([])
    expect([...walkedTrees]).toEqual([])
    expect([...renders.keys()]).toEqual([])
    expect([...summaryRenders.keys()]).toEqual([])
    expect(project).not.toHaveBeenCalled()
    expect(indexReferenceSlots).toBe(0)
    expect(recordReads).toBe(0)
    // Whole-map writes select only each pane's actual dependencies; list output may still enumerate S references.
    const liveKey = makePaneKey('awake-0', LEAF)
    for (const update of [
      () => ({
        tabsByWorktree: replaceTabBuckets(useAppStore.getState().tabsByWorktree, [
          [
            'fleet-0',
            useAppStore
              .getState()
              .tabsByWorktree['fleet-0'].map((tab) =>
                tab.id === 'awake-0' ? { ...tab, title: 'awake title' } : tab
              )
          ]
        ])
      }),
      () => ({ acknowledgedAgentsByPaneKey: { [liveKey]: 2_000_000 } }),
      () => ({ activityClearedAtByPaneKey: { [liveKey]: 2_000_000 } }),
      () => ({
        runtimeAgentOrchestrationByPaneKey: {
          [liveKey]: { taskId: 'live', dispatchId: 'live' }
        }
      })
    ]) {
      reset()
      const next = update()
      if ('tabsByWorktree' in next) {
        sleptAgentStatusByPaneKey({ ...useAppStore.getState(), ...next })
        expect(ownerRequests).not.toHaveBeenCalled()
      }
      patch(next)
      expect(project).not.toHaveBeenCalled()
      expect(treeReads).toBe(0)
      expect(ownerProbes).not.toHaveBeenCalled()
      expect(
        owners.mock.calls.filter(([, , candidate]) => candidate.paneKey.startsWith('asleep-'))
      ).toHaveLength(0)
      expect(
        paneBuild.mock.calls.filter(([input]) => input.cacheKey.startsWith('sleep:'))
      ).toHaveLength(0)
    }
    for (const update of [
      () => ({ acknowledgedAgentsByPaneKey: { [sleepKey(0)]: 2_000_000 } }),
      () => ({ activityClearedAtByPaneKey: { [sleepKey(0)]: 2_000_000 } }),
      () => ({
        runtimeAgentOrchestrationByPaneKey: {
          [sleepKey(0)]: { taskId: 'sleep', dispatchId: 'sleep', parentPaneKey: liveKey }
        }
      }),
      () => ({
        tabsByWorktree: replaceTabBuckets(useAppStore.getState().tabsByWorktree, [
          [
            'fleet-0',
            useAppStore
              .getState()
              .tabsByWorktree['fleet-0'].map((tab) =>
                tab.id === 'asleep-0' ? { ...tab, title: 'slept title' } : tab
              )
          ]
        ])
      })
    ]) {
      reset()
      patch(update())
      expect(
        paneBuild.mock.calls
          .filter(([input]) => input.cacheKey.startsWith('sleep:'))
          .map(([input]) => input.cacheKey)
      ).toEqual([`sleep:${sleepKey(0)}`])
    }
    reset()
    patch({ worktreesByRepo: { ...useAppStore.getState().worktreesByRepo } })
    expect(ownerProbes).toHaveBeenCalledTimes(sleepCount)
    expect(
      paneBuild.mock.calls.filter(([input]) => input.cacheKey.startsWith('sleep:'))
    ).toHaveLength(0)
    reset()
    const target = sleepKey(0)
    patch({
      sleepingAgentSessionsByPaneKey: replaceRecordEntries<OwnedPaneAgentRecord>(
        useAppStore.getState().sleepingAgentSessionsByPaneKey,
        [[target, sleepRecord(0, 'updated slept task')]]
      )
    })
    expect([...touchedRecords]).toEqual([target])
    expect(project).toHaveBeenCalledTimes(1)
    expect(recordReads).toBeLessThanOrEqual(8)
    expect(indexReferenceSlots).toBeLessThanOrEqual(3 * sleepCount)
    expect(
      paneBuild.mock.calls.filter(([input]) => input.cacheKey.startsWith('sleep:'))
    ).toHaveLength(1)
    expect([...walkedTrees]).toEqual([])
    expect([...renders.keys()]).toEqual(['fleet-0'])
    expect(observedRows.get('fleet-0')?.find((row) => row.paneKey === target)?.entry.prompt).toBe(
      'updated slept task'
    )
    reset()
    const beforeFocusRows = observedRows.get(`fleet-${size - 1}`)
    const focus = `awake-${size - 1}`
    patch({
      terminalLayoutsByTabId: replaceRecordEntries<TerminalLayoutSnapshot>(
        useAppStore.getState().terminalLayoutsByTabId,
        [[focus, { ...layouts[focus], expandedLeafId: LEAF }]]
      )
    })
    expect([...touchedRecords]).toEqual([])
    expect([...walkedTrees]).toEqual([])
    // The layout consumer may update its focused owner; no sleep-derived consumer changes.
    expect([...renders.keys()]).toEqual([`fleet-${size - 1}`])
    expect(observedRows.get(`fleet-${size - 1}`)).toEqual(beforeFocusRows)
    expect([...summaryRenders.keys()]).toEqual([])
    expect(project).not.toHaveBeenCalled()
    expect(indexReferenceSlots).toBe(0)
    expect(recordReads).toBe(0)
    reset()
    patch({
      terminalLayoutsByTabId: replaceRecordEntries<TerminalLayoutSnapshot>(
        useAppStore.getState().terminalLayoutsByTabId,
        [['asleep-0', null]]
      )
    })
    expect([...touchedRecords].every((key) => key === target)).toBe(true)
    expect(project.mock.calls.length).toBeLessThanOrEqual(1)
    expect(recordReads).toBeLessThanOrEqual(8)
    expect(indexReferenceSlots).toBeLessThanOrEqual(3 * sleepCount)
    expect([...walkedTrees]).toEqual([])
    expect([...renders.keys()]).toEqual(['fleet-0'])
    expect(observedRows.get('fleet-0')?.some((row) => row.paneKey === target)).toBe(false)
    expect(passiveCount).toBe(sleepCount - 1)
    reset()
    const current = useAppStore.getState()
    patch({
      tabsByWorktree: { ...current.tabsByWorktree },
      terminalLayoutsByTabId: { ...current.terminalLayoutsByTabId },
      sshConnectionStates: new Map(current.sshConnectionStates)
    })
    expect(recordReads).toBe(0)
    expect(treeReads).toBe(0)
    expect(project).not.toHaveBeenCalled()
    expect([...renders.keys()]).toEqual([])
    expect([...summaryRenders.keys()]).toEqual([])

    reset()
    const overlap = sleepKey(3)
    patch({
      agentStatusByPaneKey: replaceRecordEntries<AgentStatusEntry>(
        useAppStore.getState().agentStatusByPaneKey,
        [[overlap, entry(overlap, 'fleet-3')]]
      )
    })
    expect(
      observedRows
        .get('fleet-3')
        ?.filter((row) => row.paneKey === overlap)
        .map((row) => row.state)
    ).toEqual(['working'])
    expect(selectWorktreeAgentActivitySummary(useAppStore.getState(), 'fleet-3').hasLiveDone).toBe(
      false
    )
    expect(project).not.toHaveBeenCalled()
    expect(recordReads).toBe(0)
    patch({
      agentStatusByPaneKey: replaceRecordEntries<AgentStatusEntry>(
        useAppStore.getState().agentStatusByPaneKey,
        [[overlap, null]]
      )
    })
    expect(
      observedRows
        .get('fleet-3')
        ?.filter((row) => row.paneKey === overlap)
        .map((row) => row.state)
    ).toEqual(['done'])
    expect(selectWorktreeAgentActivitySummary(useAppStore.getState(), 'fleet-3').hasLiveDone).toBe(
      true
    )

    reset()
    const remoteKey = sleepKey(1)
    const host = {
      targetId: 'sleep-host',
      status: 'connected' as const,
      error: null,
      reconnectAttempt: 0
    }
    patch({
      sshConnectionStates: new Map([['sleep-host', host]]),
      sleepingAgentSessionsByPaneKey: replaceRecordEntries<OwnedPaneAgentRecord>(
        useAppStore.getState().sleepingAgentSessionsByPaneKey,
        [[remoteKey, { ...sleepRecord(1), connectionId: 'sleep-host' }]]
      )
    })
    reset()
    patch({
      sshConnectionStates: new Map([
        ['sleep-host', host],
        ['unrelated-host', { ...host, targetId: 'unrelated-host' }]
      ])
    })
    expect(project).not.toHaveBeenCalled()
    expect(recordReads).toBe(0)
    expect([...renders.keys()]).toEqual([])
    reset()
    patch({ sshConnectionStates: new Map([['sleep-host', { ...host, status: 'disconnected' }]]) })
    expect([...renders.keys()]).toEqual(['fleet-1'])
    expect(observedRows.get('fleet-1')?.some((row) => row.paneKey === remoteKey)).toBe(false)
    expect(project).not.toHaveBeenCalled()
    expect(treeReads).toBe(0)
    patch({ sshConnectionStates: new Map([['sleep-host', host]]) })
    expect(observedRows.get('fleet-1')?.some((row) => row.paneKey === remoteKey)).toBe(true)
    reset()
    patch({ transientClearedAgentStatusConnectionIds: { 'sleep-host': true } })
    expect([...renders.keys()]).toEqual(['fleet-1'])
    expect(observedRows.get('fleet-1')?.some((row) => row.paneKey === remoteKey)).toBe(false)

    reset()
    const successor = sleepKey(2)
    act(() =>
      useAppStore
        .getState()
        .setAgentStatus(
          successor,
          { state: 'working', agentType: 'claude', prompt: 'successor task' },
          undefined,
          { updatedAt: 2_000_010 },
          { tabId: 'asleep-2', worktreeId: 'fleet-2', connectionId: null }
        )
    )
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[successor]).toBeUndefined()
    act(() => useAppStore.getState().removeAgentStatus(successor))
    expect(observedRows.get('fleet-2')?.some((row) => row.paneKey === successor)).toBe(false)
    // Replacing a hydrated store must reconcile every current owner and evict removed sources.
    patch({
      tabsByWorktree: tabs,
      terminalLayoutsByTabId: layouts,
      agentStatusByPaneKey: live,
      sleepingAgentSessionsByPaneKey: records,
      transientClearedAgentStatusConnectionIds: {},
      sshConnectionStates: new Map()
    })
    expect(passiveCount).toBe(sleepCount)
    expect(
      observedRows
        .get('fleet-0')
        ?.map((row) => row.state)
        .toSorted()
    ).toEqual(['done', 'working'])
    patch({
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {}
    })
    expect(sleptAgentEntriesByWorktree(useAppStore.getState()).size).toBe(0)
    expect(sleptAgentStatusByPaneKey(useAppStore.getState()).size).toBe(0)
    expect(passiveCount).toBe(0)
  }
)
