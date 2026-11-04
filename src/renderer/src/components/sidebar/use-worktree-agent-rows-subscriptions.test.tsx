// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { readStoreListenerCount } from '@/store/store-listener-census'
import { makeTab } from '@/store/slices/store-test-helpers'
import type { AppState } from '@/store/types'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'
import { verifyMirroredTerminalLineage } from './mirrored-terminal-lineage.test-fixture'
import type { RuntimeAgentLineageTestModule } from '../../../../shared/runtime-agent-lineage-consumer.test-fixture'
import { isStructuredTab } from '../../../../shared/structured-agent-session-tab'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

// Load the native graph during collection; fixture state stays per test.
const {
  default: { publicLineageFixture, canonicalChatRow, LINEAGE_PARENT, LINEAGE_CHILD }
} = await vi.importActual<{ default: RuntimeAgentLineageTestModule }>(
  '../../../../main/runtime/runtime-agent-lineage.test-fixture'
)

const LEAF = '11111111-1111-4111-8111-111111111111'
const KEY_A = makePaneKey('tab-a', LEAF)
const KEY_B = makePaneKey('tab-b', LEAF)
const original = useAppStore.getState()
let root: Root
let container: HTMLDivElement
let rows: DashboardAgentRow[]
let renders: number

function Probe({
  worktreeId = 'folder-a',
  active = true
}: {
  worktreeId?: string
  active?: boolean
}) {
  rows = useWorktreeAgentRows(worktreeId, active)
  renders += 1
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
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    paneForegroundAgentByPaneKey: {}
  })
  renders = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.setState(original, true)
  vi.useRealTimers()
})

describe('mounted worktree agent row subscriptions', () => {
  it('listens once while active and releases its listener while inactive', () => {
    const baseline = readStoreListenerCount() ?? 0
    act(() => root.render(<Probe />))
    expect(readStoreListenerCount()).toBe(baseline + 1)
    expect(rows[0].entry.prompt).toBe('folder-a')
    act(() => root.render(<Probe active={false} />))
    expect(readStoreListenerCount()).toBe(baseline)
    expect(rows).toEqual([])
    const before = renders
    patch({ activeWorktreeId: 'ssh-b' })
    expect(renders).toBe(before)
    patch({
      agentStatusByPaneKey: {
        ...useAppStore.getState().agentStatusByPaneKey,
        [KEY_A]: { ...entry(KEY_A, 'folder-a'), prompt: 'changed while disabled' }
      }
    })
    act(() => root.render(<Probe />))
    expect(rows[0].entry.prompt).toBe('changed while disabled')
    expect(readStoreListenerCount()).toBe(baseline + 1)
  })

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

  it('keeps unrelated cards stable while a working agent reports new tool output', () => {
    act(() => root.render(<Probe />))
    const beforeRows = rows
    const before = renders
    act(() =>
      useAppStore
        .getState()
        .setAgentStatus(
          KEY_B,
          { state: 'working', agentType: 'claude', prompt: 'new output', toolName: 'Read' },
          undefined,
          { updatedAt: Date.now() + 1 },
          { tabId: 'tab-b', worktreeId: 'ssh-b', connectionId: 'ssh:host' }
        )
    )
    expect(rows).toBe(beforeRows)
    expect(renders).toBe(before)
    act(() =>
      useAppStore
        .getState()
        .setAgentStatus(
          KEY_A,
          { state: 'working', agentType: 'claude', prompt: 'local output', toolName: 'Edit' },
          undefined,
          { updatedAt: Date.now() + 2 },
          { tabId: 'tab-a', worktreeId: 'folder-a' }
        )
    )
    expect(rows[0].entry.toolName).toBe('Edit')
    expect(renders).toBe(before + 1)
  })

  it('decays on an epoch-only freshness tick', () => {
    act(() => root.render(<Probe />))
    expect(rows[0].state).toBe('working')
    vi.setSystemTime(Date.now() + AGENT_STATUS_STALE_AFTER_MS + 1)
    patch({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 })
    expect(rows[0].state).toBe('idle')
  })

  it('observes title, PTY, layout, orchestration, foreground, migration and retention inputs', () => {
    act(() => root.render(<Probe />))
    const updates: Partial<AppState>[] = [
      { runtimePaneTitlesByTabId: { 'tab-a': { 0: 'Claude Code' } } },
      { ptyIdsByTabId: { 'tab-a': ['pty-a'] } },
      {
        terminalLayoutsByTabId: {
          'tab-a': {
            root: { type: 'leaf', leafId: LEAF },
            activeLeafId: LEAF,
            expandedLeafId: null
          }
        }
      },
      {
        runtimeAgentOrchestrationByPaneKey: {
          [KEY_A]: { taskId: 'task', dispatchId: 'dispatch', taskTitle: 'New task' }
        }
      },
      { paneForegroundAgentByPaneKey: { [KEY_A]: { agent: 'claude', shellForeground: false } } },
      {
        migrationUnsupportedByPtyId: {
          legacy: {
            ptyId: 'legacy',
            worktreeId: 'folder-a',
            tabId: 'tab-a',
            leafId: LEAF,
            paneKey: KEY_A,
            reason: 'legacy-numeric-pane-key',
            source: 'local',
            updatedAt: Date.now()
          }
        }
      },
      {
        retainedAgentsByPaneKey: {
          [KEY_B]: {
            entry: entry(KEY_B, 'folder-a'),
            worktreeId: 'folder-a',
            tab: makeTab({ id: 'tab-b', worktreeId: 'folder-a' }),
            agentType: 'claude',
            startedAt: Date.now()
          }
        }
      }
    ]
    for (const update of updates) {
      const before = rows
      patch(update)
      expect(rows).not.toBe(before)
    }
  })
})

it.each([20, 200])(
  'shares canonical receiving/alias work and preserves unaffected mounted rows at %i worktrees',
  async (n) => {
    const { structuredAgentSessionPaneKey: pane, structuredAgentSessionTabId: tabId } =
      await import('../../../../shared/structured-agent-session-projection')
    const { makeUnifiedTab } = await import('@/store/slices/store-test-helpers')
    const { visibleOrchestrationWorkForTest } =
      await import('@/runtime/visible-agent-orchestration')
    const { _getWorktreeAgentOrchestrationIndexBuildCountForTest: indexBuilds } =
      await import('./worktree-agent-orchestration-index')
    const live: AppState['agentStatusByPaneKey'] = {}
    const tabs: AppState['unifiedTabsByWorktree'] = {}
    const raw: AppState['runtimeAgentOrchestrationByPaneKey'] = {}
    const observed = new Map<number, DashboardAgentRow[]>()
    const counts = new Map<number, number>()
    for (let i = 0; i < n; i++) {
      const worktreeId = `lineage-${i}`
      tabs[worktreeId] = ['parent', 'child'].map((role) =>
        makeUnifiedTab({
          id: `${role}-actual-${i}`,
          entityId: `${role}-${i}`,
          groupId: 'group',
          worktreeId,
          contentType: 'agent-session',
          agentSessionAgent: 'codex',
          executionHostId: i === n - 1 ? 'runtime:other' : 'local'
        })
      )
      for (const tab of tabs[worktreeId]) {
        live[pane(tab.id, tab.entityId)] = {
          ...entry(pane(tab.id, tab.entityId), worktreeId),
          agentType: 'codex',
          tabId: tab.id
        }
      }
      raw[pane(tabId(`child-${i}`), `child-${i}`)] = {
        taskId: `task-${i}`,
        dispatchId: `dispatch-${i}`,
        dispatchStatus: 'dispatched',
        parentPaneKey: pane(tabId(`parent-${i}`), `parent-${i}`)
      }
    }
    patch({
      tabsByWorktree: {},
      unifiedTabsByWorktree: tabs,
      agentStatusByPaneKey: live,
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey: {}
    })
    act(() => useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey(raw))
    function ManyProbe({ index }: { index: number }) {
      observed.set(index, useWorktreeAgentRows(`lineage-${index}`))
      counts.set(index, (counts.get(index) ?? 0) + 1)
      return null
    }
    act(() =>
      root.render(Array.from({ length: n }, (_, index) => <ManyProbe key={index} index={index} />))
    )
    const initial = new Map(observed)
    counts.clear()
    const beforeEqual = visibleOrchestrationWorkForTest()
    const canonicalBefore = useAppStore.getState().runtimeAgentOrchestrationByPaneKey
    act(() => useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey(structuredClone(raw)))
    expect(useAppStore.getState().runtimeAgentOrchestrationByPaneKey).toBe(canonicalBefore)
    expect(counts.size).toBe(0)
    expect(visibleOrchestrationWorkForTest()).toEqual(beforeEqual)
    const changedKey = pane(tabId('child-0'), 'child-0')
    for (const change of [
      { taskTitle: 'A real new title' },
      { dispatchStatus: 'completed' as const },
      { attention: { categories: ['input' as const], requiresAction: true } },
      { parentPaneKey: 'missing-parent' }
    ]) {
      const before = visibleOrchestrationWorkForTest()
      const beforeIndex = indexBuilds()
      counts.clear()
      act(() =>
        useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey({
          ...useAppStore.getState().runtimeAgentOrchestrationByPaneKey,
          [changedKey]: { ...raw[changedKey], ...change }
        })
      )
      expect(counts.get(0)).toBe(1)
      expect(
        observed.get(0)?.find((row) => row.paneKey === pane('child-actual-0', 'child-0'))?.entry
          .orchestration
      ).toMatchObject(change)
      for (let i = 1; i < n; i++) {
        expect(counts.has(i)).toBe(false)
        expect(observed.get(i)).toBe(initial.get(i))
      }
      const after = visibleOrchestrationWorkForTest()
      expect(after.builds - before.builds).toBeLessThanOrEqual(1)
      expect(after.aliasBuilds).toBe(before.aliasBuilds)
      expect(indexBuilds() - beforeIndex).toBeLessThanOrEqual(1)
      expect(after.visits - before.visits).toBeLessThanOrEqual(n * 14)
    }
    act(() => useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey(raw))
    // Releasing one relationship preserves unrelated arrays even while its embedded completion remains.
    counts.clear()
    const remaining = { ...useAppStore.getState().runtimeAgentOrchestrationByPaneKey }
    delete remaining[changedKey]
    act(() => useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey(remaining))
    for (let i = 1; i < n; i++) {
      expect(observed.get(i)).toBe(initial.get(i))
    }
    const epoch = useAppStore.getState().agentStatusEpoch
    const beforeAlias = visibleOrchestrationWorkForTest()
    patch({
      unifiedTabsByWorktree: {
        ...tabs,
        'lineage-0': tabs['lineage-0'].map((tab) =>
          tab.entityId === 'parent-0' ? { ...tab, id: 'remapped-parent' } : tab
        )
      }
    })
    expect(
      observed.get(0)?.find((row) => row.paneKey === pane('child-actual-0', 'child-0'))?.entry
        .orchestration?.parentPaneKey
    ).toBe(pane('remapped-parent', 'parent-0'))
    expect(useAppStore.getState().agentStatusEpoch).toBe(epoch)
    for (let i = 1; i < n; i++) {
      expect(observed.get(i)).toBe(initial.get(i))
    }
    expect(visibleOrchestrationWorkForTest().builds - beforeAlias.builds).toBe(1)
    // A host change cannot attach a local worker to an identically named foreign parent.
    patch({
      unifiedTabsByWorktree: {
        ...tabs,
        'lineage-0': tabs['lineage-0'].map((tab) =>
          tab.entityId === 'parent-0' ? { ...tab, executionHostId: 'runtime:other' } : tab
        )
      }
    })
    expect(
      observed.get(0)?.find((row) => row.paneKey === pane('child-actual-0', 'child-0'))?.entry
        .orchestration?.parentPaneKey
    ).not.toBe(pane('parent-actual-0', 'parent-0'))
    for (let i = 1; i < n; i++) {
      expect(observed.get(i)).toBe(initial.get(i))
    }
    counts.clear()
    const foreignRow = pane(`child-actual-${n - 1}`, `child-${n - 1}`)
    const beforeForeign = visibleOrchestrationWorkForTest()
    const beforeForeignIndex = indexBuilds()
    const { projectStatus } =
      await import('@/components/native-chat/structured-agent-session-status-projection')
    const foreignTab = tabs[`lineage-${n - 1}`][1]
    if (!isStructuredTab(foreignTab)) {
      throw new Error('Expected the native session tab')
    }
    act(() =>
      useAppStore.getState().transactAgentStatuses((transaction) =>
        projectStatus(
          transaction,
          foreignTab,
          {
            sessionId: foreignTab.entityId,
            workspaceId: foreignTab.worktreeId,
            agent: 'codex',
            status: 'working',
            latestPrompt: 'Another host update',
            updatedAt: Date.now() + 1,
            hostExecutionOwned: true
          },
          'live',
          null
        )
      )
    )
    expect(counts.get(n - 1)).toBe(1)
    expect(observed.get(n - 1)?.find((row) => row.paneKey === foreignRow)?.entry.prompt).toBe(
      'Another host update'
    )
    for (let i = 0; i < n - 1; i++) {
      expect(counts.has(i)).toBe(false)
    }
    const afterForeign = visibleOrchestrationWorkForTest()
    expect(afterForeign.builds - beforeForeign.builds).toBeLessThanOrEqual(1)
    expect(afterForeign.aliasBuilds).toBe(beforeForeign.aliasBuilds)
    expect(indexBuilds() - beforeForeignIndex).toBeLessThanOrEqual(1)
    expect(afterForeign.visits - beforeForeign.visits).toBeLessThanOrEqual(n * 14)
  }
)

it('joins production mirrored custom/collision rows locally and keeps canonical initial, graph, retained and consumer contexts', async () => {
  const { makeUnifiedTab, makeWorktree, TEST_REPO } =
    await import('@/store/slices/store-test-helpers')
  const { buildMirroredAgentTabs } =
    await import('@/runtime/web-session-tabs-sync/terminal-surfaces')
  const { projectStatus } =
    await import('@/components/native-chat/structured-agent-session-status-projection')
  const { getStructuredAgentSessionTabs } =
    await import('@/components/native-chat/structured-agent-session-tabs')
  const { selectVisibleAgentOrchestration } = await import('@/runtime/visible-agent-orchestration')
  const { structuredAgentSessionPaneKey: pane, structuredAgentSessionTabId: tabId } =
    await import('../../../../shared/structured-agent-session-projection')
  const { selectWorktreeAgentActivitySummary } = await import('./worktree-agent-activity-summary')
  const { selectDashboardOrchestration } =
    await import('@/components/dashboard/dashboard-orchestration-selection')
  const { selectWorktreeAgentRowsCached } =
    await import('@/components/dashboard/worktree-agent-rows-cache')
  const { buildActivityEvents } = await import('@/components/activity/activity-event-builder')
  const f = publicLineageFixture('folder-a')
  try {
    const predecessor = makeUnifiedTab({
      id: 'reserved-parent',
      entityId: 'old-parent',
      groupId: 'g',
      worktreeId: 'folder-a',
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      executionHostId: 'local'
    })
    const occupied = makeUnifiedTab({
      id: tabId(LINEAGE_CHILD),
      entityId: 'unrelated',
      groupId: 'g',
      worktreeId: 'folder-a'
    })
    const mirrored = buildMirroredAgentTabs(
      {
        worktree: 'folder-a',
        publicationEpoch: 'test',
        snapshotVersion: 1,
        activeGroupId: 'g',
        activeTabId: null,
        activeTabType: 'agent-session',
        tabs: [
          {
            type: 'agent-session',
            id: 'host-parent',
            title: 'Parent',
            sessionId: LINEAGE_PARENT,
            replacesSessionId: 'old-parent',
            agent: 'codex',
            isActive: false
          },
          {
            type: 'agent-session',
            id: 'host-child',
            title: 'Child',
            sessionId: LINEAGE_CHILD,
            agent: 'codex',
            isActive: false
          }
        ]
      },
      'local',
      new Map(),
      'g',
      0,
      [predecessor, occupied],
      Date.now()
    ).map((item) => item.unifiedTab)
    expect(mirrored[0].id).toBe('reserved-parent')
    expect(mirrored[1].id).toContain(':history-1')
    const raw = f.projection.buildByPaneKey() ?? {}
    patch({
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {},
      runtimeAgentOrchestrationByPaneKey: {}
    })
    act(() => useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey(raw))
    const canonical = useAppStore.getState().runtimeAgentOrchestrationByPaneKey
    patch({ unifiedTabsByWorktree: { 'folder-a': mirrored } })
    const actualParent = pane(mirrored[0].id, LINEAGE_PARENT)
    const actualChild = pane(mirrored[1].id, LINEAGE_CHILD)
    expect(selectVisibleAgentOrchestration(useAppStore.getState())[actualChild].parentPaneKey).toBe(
      actualParent
    )
    const emitStatuses = () =>
      act(() =>
        useAppStore.getState().transactAgentStatuses((transaction) => {
          for (const tab of getStructuredAgentSessionTabs(
            useAppStore.getState().unifiedTabsByWorktree
          )) {
            projectStatus(
              transaction,
              tab,
              {
                sessionId: tab.entityId,
                workspaceId: tab.worktreeId,
                agent: 'codex',
                status: 'working',
                latestPrompt: tab.label,
                updatedAt: Date.now(),
                hostExecutionOwned: true
              },
              'live',
              null
            )
          }
        })
      )
    emitStatuses()
    expect(
      useAppStore.getState().agentStatusByPaneKey[actualChild].orchestration?.parentPaneKey
    ).toBe(canonicalChatRow(LINEAGE_PARENT))
    expect(useAppStore.getState().runtimeAgentOrchestrationByPaneKey).toBe(canonical)
    act(() => root.render(<Probe />))
    expect(rows.map((row) => row.paneKey)).toEqual([actualParent, actualChild])
    expect(rows[1].entry.orchestration?.parentPaneKey).toBe(actualParent)
    const worktree = makeWorktree({ id: 'folder-a', repoId: TEST_REPO.id })
    patch({ repos: [TEST_REPO], worktreesByRepo: { [TEST_REPO.id]: [worktree] } })
    const state = useAppStore.getState()
    const singleton = selectDashboardOrchestration(state, [{ worktree }]).singletonOrchestration
    const batch = selectDashboardOrchestration(state, [
      { worktree },
      { worktree: { ...worktree, id: 'other' } }
    ]).orchestrationByWorktree?.get('folder-a')
    expect(batch).toBe(singleton)
    const dashboard = selectWorktreeAgentRowsCached({
      state,
      worktreeId: 'folder-a',
      orchestration: singleton ?? {},
      now: Date.now(),
      generation: 1
    })
    expect(dashboard.map((row) => row.lineage?.depth)).toEqual([0, 1])
    expect(selectWorktreeAgentActivitySummary(state, 'folder-a').hasLiveWorking).toBe(true)
    const activity = buildActivityEvents({
      ...state,
      chatNames: new Map(),
      tabsByWorktree: state.tabsByWorktree,
      unifiedTabsByWorktree: state.unifiedTabsByWorktree,
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[TEST_REPO.id, TEST_REPO]]),
      runtimeAgentOrchestrationByPaneKey: selectVisibleAgentOrchestration(state),
      now: Date.now()
    })
    expect(activity.paneEntryByPaneKey[actualChild]?.orchestration?.parentPaneKey).toBe(
      actualParent
    )
    expect(activity.paneEntryByPaneKey[actualParent]).toBeDefined()
    const { getWorkspaceCleanupAgentEvidence } =
      await import('@/store/slices/workspace-cleanup-agent-evidence')
    const { makeCandidate } = await import('@/store/slices/workspace-cleanup-slice-test-harness')
    expect([
      ...getWorkspaceCleanupAgentEvidence(state, [
        makeCandidate({ worktreeId: 'folder-a', executionHostId: 'local' })
      ]).values()
    ]).toEqual(['live'])
    const { buildDashboardSnapshot } =
      await import('@/components/dashboard/build-dashboard-snapshot')
    const snapshot = buildDashboardSnapshot({ ...state, chatNames: new Map() }, Date.now())
    expect(JSON.stringify(snapshot)).toContain(actualChild)
    expect(JSON.stringify(snapshot)).toContain(actualParent)

    // Payload-before-graph and a retained terminal child's embedded parent use that same read-side join.
    act(() => useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey({}))
    expect(selectVisibleAgentOrchestration(useAppStore.getState())[actualChild].parentPaneKey).toBe(
      actualParent
    )
    const terminal = {
      ...entry(KEY_B, 'folder-a'),
      state: 'done' as const,
      orchestration: raw[canonicalChatRow(LINEAGE_CHILD)]
    }
    act(() =>
      useAppStore.getState().retainAgents([
        {
          entry: terminal,
          worktreeId: 'folder-a',
          tab: makeTab({ id: 'tab-b', worktreeId: 'folder-a' }),
          agentType: 'codex',
          startedAt: Date.now()
        }
      ])
    )
    expect(selectVisibleAgentOrchestration(useAppStore.getState())[KEY_B].parentPaneKey).toBe(
      actualParent
    )
    // Alias rederivation is immediate and writes neither canonical storage nor an epoch.
    const epoch = useAppStore.getState().agentStatusEpoch
    patch({
      unifiedTabsByWorktree: {
        'folder-a': mirrored.map((tab, index) => (index === 0 ? { ...tab, id: 'new-parent' } : tab))
      }
    })
    expect(selectVisibleAgentOrchestration(useAppStore.getState())[actualChild].parentPaneKey).toBe(
      pane('new-parent', LINEAGE_PARENT)
    )
    expect(useAppStore.getState().agentStatusEpoch).toBe(epoch)
    patch({
      unifiedTabsByWorktree: {
        'folder-a': mirrored.map((tab, index) =>
          index === 0 ? { ...tab, executionHostId: 'runtime:foreign' } : tab
        )
      }
    })
    expect(
      selectVisibleAgentOrchestration(useAppStore.getState())[actualChild]?.parentPaneKey
    ).not.toBe(actualParent)
  } finally {
    f.db.close()
  }
})

it.each(['default', 'reserved', 'collision'] as const)(
  'joins mirrored live/retained terminal contexts with positive provenance and a %s parent',
  async (kind) => {
    await verifyMirroredTerminalLineage(kind, {
      patch,
      entry,
      mount: () => act(() => root.render(<Probe />)),
      getRows: () => rows
    })
  }
)

it('settles the production graph subscription/scheduler/publication/receiver loop with at most one feedback flight', async () => {
  const { useRuntimeGraphSync } = await import('@/app-shell/use-runtime-graph-sync')
  const { setRuntimeGraphSyncEnabled, setRuntimeGraphStoreStateGetter } =
    await import('@/runtime/sync-runtime-graph')
  const { graphState } = await import('@/runtime/sync-runtime-graph/graph-state')
  const { makeUnifiedTab } = await import('@/store/slices/store-test-helpers')
  const { selectVisibleAgentOrchestration } = await import('@/runtime/visible-agent-orchestration')
  const { structuredAgentSessionPaneKey: pane } =
    await import('../../../../shared/structured-agent-session-projection')
  const f = publicLineageFixture('folder-a')
  const response = {
    runtimeId: 'lineage',
    rendererGraphEpoch: 1,
    graphStatus: 'ready' as const,
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    agentOrchestrationByPaneKey: f.projection.buildByPaneKey()
  }
  let release: (() => void) | undefined
  let fail = false
  let hold = true
  const previousApi = window.api
  const sync = vi.fn(async () => {
    if (hold) {
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    if (fail) {
      throw new Error('expected transport failure')
    }
    return structuredClone(response)
  })
  Reflect.set(window, 'api', {
    ...previousApi,
    runtime: { ...previousApi?.runtime, syncWindowGraph: sync }
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  function SyncProbe() {
    useRuntimeGraphSync()
    return null
  }
  const flush = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })
  try {
    patch({
      workspaceSessionReady: true,
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      retainedAgentsByPaneKey: {},
      runtimeAgentOrchestrationByPaneKey: {},
      agentStatusByPaneKey: {
        [canonicalChatRow(LINEAGE_CHILD)]: entry(canonicalChatRow(LINEAGE_CHILD), 'folder-a')
      }
    })
    act(() => root.render(<SyncProbe />))
    await flush()
    expect(sync).toHaveBeenCalledTimes(1)
    const parent = makeUnifiedTab({
      id: 'late-parent',
      entityId: LINEAGE_PARENT,
      groupId: 'g',
      worktreeId: 'folder-a',
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      executionHostId: 'local'
    })
    patch({ unifiedTabsByWorktree: { 'folder-a': [parent] } })
    hold = false
    await act(async () => {
      release?.()
      await Promise.resolve()
    })
    await flush()
    expect(sync).toHaveBeenCalledTimes(2)
    const stable = useAppStore.getState()
    expect(
      selectVisibleAgentOrchestration(stable)[canonicalChatRow(LINEAGE_CHILD)].parentPaneKey
    ).toBe(pane(parent.id, LINEAGE_PARENT))
    await flush()
    expect(sync).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().runtimeAgentOrchestrationByPaneKey).toBe(
      stable.runtimeAgentOrchestrationByPaneKey
    )
    expect(useAppStore.getState().agentStatusByPaneKey).toBe(stable.agentStatusByPaneKey)
    expect(useAppStore.getState().agentStatusEpoch).toBe(stable.agentStatusEpoch)
    fail = true
    patch({ unifiedTabsByWorktree: { 'folder-a': [{ ...parent, label: 'legitimate wake' }] } })
    await flush()
    expect(sync).toHaveBeenCalledTimes(3)
    expect(graphState.syncInFlight).toBe(false)
    await flush()
    expect(sync).toHaveBeenCalledTimes(3)
    setRuntimeGraphSyncEnabled(false)
    patch({ unifiedTabsByWorktree: { 'folder-a': [{ ...parent, id: 'disabled-local-alias' }] } })
    expect(
      selectVisibleAgentOrchestration(useAppStore.getState())[canonicalChatRow(LINEAGE_CHILD)]
        .parentPaneKey
    ).toBe(pane('disabled-local-alias', LINEAGE_PARENT))
    await flush()
    expect(sync).toHaveBeenCalledTimes(3)
    fail = false
    setRuntimeGraphSyncEnabled(true)
    await flush()
    expect(sync).toHaveBeenCalledTimes(4)
    await flush()
    expect(sync).toHaveBeenCalledTimes(4)
  } finally {
    setRuntimeGraphSyncEnabled(false)
    setRuntimeGraphStoreStateGetter(null)
    Reflect.set(window, 'api', previousApi)
    error.mockRestore()
    f.db.close()
  }
})
