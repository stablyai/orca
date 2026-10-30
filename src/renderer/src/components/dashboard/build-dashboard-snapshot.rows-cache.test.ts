// @vitest-environment happy-dom

import { dashboardCardDisplayState } from '../../../../shared/dashboard-snapshot'
import { admitDashboardSnapshot } from '../../../../main/ipc/dashboard-payload-validation'
import { buildDashboardBucketCounts } from './build-dashboard-bucket-counts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, Fragment } from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import * as snapshotBuilder from './build-dashboard-snapshot'
import { useDashboardPopoutBridge } from './useDashboardPopoutBridge'
import { useDashboardSnapshot } from '../dashboard-popout/useDashboardSnapshot'
import { AgentKanbanCard } from '../dashboard-popout/AgentKanbanCard'
import { AgentTerminalPanel } from '../dashboard-popout/AgentTerminalDialog'
import { projectStatus } from '../native-chat/structured-agent-session-status-projection'
import type { StructuredTab } from '../native-chat/structured-agent-session-tabs'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import type { DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import type { ExecutionHostId } from '../../../../shared/execution-host'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})
vi.mock('@/runtime/structured-chat-name-observation', () => ({
  subscribeStructuredChatTabNames: () => () => {},
  getStructuredChatTabNames: () => new Map()
}))
vi.mock('./dashboard-chat-program-acquisition', () => ({
  createDashboardChatProgramHolds: () => ({ reconcile: () => {}, release: () => {} })
}))
const iconRender = vi.hoisted(() => vi.fn())
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent, size }: { agent: string; size: number }) => {
    if (size === 14) {
      iconRender(agent)
    }
    return null
  }
}))

import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status/agent-status-contract'
import {
  buildDashboardSnapshot,
  type DashboardSnapshotInput as DashboardSnapshotState
} from './build-dashboard-snapshot'
import { createWorktreeAgentRowsCache } from './worktree-agent-rows-cache'

const NOW = 1_000_000_000
const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const PANE_1 = makePaneKey('tab1', LEAF_1)
const PANE_2 = makePaneKey('tab2', LEAF_2)

function worktree(id: string): Worktree {
  return {
    id,
    repoId: 'r1',
    path: `/r1/${id}`,
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: NOW
  }
}

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW
  }
}

function entry(
  paneKey: string,
  tabId: string,
  worktreeId: string,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    paneKey,
    state: 'done',
    prompt: 'finish the task',
    updatedAt: NOW,
    stateStartedAt: NOW - 5_000,
    stateHistory: [],
    agentType: 'claude',
    tabId,
    worktreeId,
    ...overrides
  }
}

function baseState(overrides: Partial<DashboardSnapshotState> = {}): DashboardSnapshotState {
  return {
    chatNames: new Map(),
    repos: [{ id: 'r1', path: '/r1', displayName: 'Repo One', badgeColor: '#000', addedAt: 1 }],
    worktreesByRepo: { r1: [worktree('w1'), worktree('w2')] },
    tabsByWorktree: { w1: [tab('tab1', 'w1')], w2: [tab('tab2', 'w2')] },
    agentStatusByPaneKey: {
      [PANE_1]: entry(PANE_1, 'tab1', 'w1'),
      [PANE_2]: entry(PANE_2, 'tab2', 'w2')
    },
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId: {
      tab1: {
        root: { type: 'leaf', leafId: LEAF_1 },
        activeLeafId: LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: 'pty-tab1' }
      },
      tab2: {
        root: { type: 'leaf', leafId: LEAF_2 },
        activeLeafId: LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_2]: 'pty-tab2' }
      }
    },
    ptyIdsByTabId: { tab1: ['pty-tab1'], tab2: ['pty-tab2'] },
    runtimePaneTitlesByTabId: { tab1: { 0: 'shell' }, tab2: { 0: 'shell' } },
    acknowledgedAgentsByPaneKey: {},
    settings: null,
    ...overrides
  }
}

describe('buildDashboardSnapshot rows cache', () => {
  it.each([
    ['cancellation', 'interrupted'],
    ['failure', 'failed'],
    ['unconfirmed', 'unconfirmed'],
    ['success', 'idle']
  ] as const)(
    'preserves %s through snapshot admission without changing columns',
    (outcome, mark) => {
      const state = baseState({
        agentStatusByPaneKey: {
          [PANE_1]: entry(PANE_1, 'tab1', 'w1', {
            state: 'done',
            mainAgent: { state: 'done', outcome, stateStartedAt: NOW - 5000 }
          })
        },
        acknowledgedAgentsByPaneKey: { [PANE_1]: NOW }
      })
      const snapshot = buildDashboardSnapshot(state, NOW)
      const admitted = admitDashboardSnapshot(snapshot)
      expect(admitted?.droppedCardCount).toBe(0)
      const card = admitted!.snapshot.cards[0]
      expect(dashboardCardDisplayState(card)).toBe(mark)
      expect(card.bucket).toBe('idle')
      expect(buildDashboardBucketCounts(state, NOW).idle).toBe(1)
      for (const acknowledgedAgentsByPaneKey of [{}, { [PANE_1]: NOW }]) {
        const aged = buildDashboardSnapshot(
          { ...state, acknowledgedAgentsByPaneKey },
          NOW + AGENT_STATUS_STALE_AFTER_MS + 1000
        )
        expect(dashboardCardDisplayState(aged.cards[0])).toBe(
          outcome === 'success' ? (aged.cards[0].unseen ? 'done' : 'idle') : mark
        )
      }
    }
  )

  it('keeps failure separate from live children and pending questions', () => {
    for (const state of ['working', 'waiting'] as const) {
      const snapshot = buildDashboardSnapshot(
        baseState({
          agentStatusByPaneKey: {
            [PANE_1]: entry(PANE_1, 'tab1', 'w1', {
              state,
              interactivePrompt: 'Approve deploy?',
              mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: NOW - 1000 }
            })
          }
        }),
        NOW
      )
      expect(dashboardCardDisplayState(snapshot.cards[0])).toBe('failed')
      expect(snapshot.cards[0].bucket).toBe(state === 'working' ? 'working' : 'attention')
      expect(snapshot.cards[0].askSummary).toBe(state === 'waiting' ? 'Approve deploy?' : undefined)
      const aged = buildDashboardSnapshot(
        baseState({
          agentStatusByPaneKey: {
            [PANE_1]: entry(PANE_1, 'tab1', 'w1', {
              state,
              mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: NOW - 1000 }
            })
          }
        }),
        NOW + AGENT_STATUS_STALE_AFTER_MS + 1000
      )
      expect(aged.cards[0].dotState).toBe('idle')
      expect(dashboardCardDisplayState(aged.cards[0])).toBe('failed')
    }
  })

  it('matches the uncached snapshot exactly across unrelated and targeted writes', () => {
    const cache = createWorktreeAgentRowsCache()
    const first = baseState()
    expect(buildDashboardSnapshot(first, NOW, { rowsCache: cache, rowsGeneration: 1 })).toEqual(
      buildDashboardSnapshot(first, NOW)
    )

    const titleWrite: DashboardSnapshotState = {
      ...first,
      runtimePaneTitlesByTabId: { ...first.runtimePaneTitlesByTabId, tab2: { 0: 'sh' } }
    }
    const cached = buildDashboardSnapshot(titleWrite, NOW + 500, {
      rowsCache: cache,
      rowsGeneration: 1
    })
    expect(cache.lastComputedWorktreeIds).toEqual(['w2'])
    expect(cached).toEqual(buildDashboardSnapshot(titleWrite, NOW + 500))
  })

  it('recomputes only the worktree whose pane foreground process changed', () => {
    const cache = createWorktreeAgentRowsCache()
    const state: DashboardSnapshotState = {
      ...baseState(),
      agentStatusByPaneKey: { [PANE_1]: entry(PANE_1, 'tab1', 'w1') },
      runtimePaneTitlesByTabId: { tab1: { 0: 'shell' }, tab2: { 0: 'demo-repo' } }
    }
    buildDashboardSnapshot(state, NOW, { rowsCache: cache, rowsGeneration: 1 })

    const codexStarted: DashboardSnapshotState = {
      ...state,
      paneForegroundAgentByPaneKey: {
        [PANE_2]: { agent: 'codex', agentEvidence: 'process-read', shellForeground: false }
      }
    }
    const cached = buildDashboardSnapshot(codexStarted, NOW + 500, {
      rowsCache: cache,
      rowsGeneration: 1
    })
    expect(cache.lastComputedWorktreeIds).toEqual(['w2'])
    expect(cached.cards.find((card) => card.paneKey === PANE_2)?.agentType).toBe('codex')
    expect(cached).toEqual(buildDashboardSnapshot(codexStarted, NOW + 500))
  })

  it('keeps card-level fields fresh (acks, workspace statuses) without recomputing rows', () => {
    const cache = createWorktreeAgentRowsCache()
    const state = baseState()
    const before = buildDashboardSnapshot(state, NOW, { rowsCache: cache, rowsGeneration: 1 })
    expect(before.cards.find((card) => card.paneKey === PANE_1)?.unseen).toBe(true)

    const acked: DashboardSnapshotState = {
      ...state,
      acknowledgedAgentsByPaneKey: { [PANE_1]: NOW }
    }
    const after = buildDashboardSnapshot(acked, NOW + 500, { rowsCache: cache, rowsGeneration: 1 })
    // Acknowledgments/status affect fresh card assembly even when the row cache hits.
    expect(cache.lastComputedWorktreeIds).toEqual([])
    expect(after.cards.find((card) => card.paneKey === PANE_1)?.unseen).toBe(false)
    expect(after).toEqual(buildDashboardSnapshot(acked, NOW + 500))
  })

  it('recomputes all worktrees when the freshness generation ticks', () => {
    const cache = createWorktreeAgentRowsCache()
    const state = baseState()
    buildDashboardSnapshot(state, NOW, { rowsCache: cache, rowsGeneration: 1 })
    buildDashboardSnapshot(state, NOW + 60_000, { rowsCache: cache, rowsGeneration: 2 })
    expect(cache.lastComputedWorktreeIds.sort()).toEqual(['w1', 'w2'])
  })

  it('refreshes a retained row from a provider title published to its current tab', () => {
    const cache = createWorktreeAgentRowsCache()
    const retainedTab = { ...tab('tab1', 'w1'), title: 'Claude ready' }
    const retained: RetainedAgentEntry = {
      entry: {
        ...entry(PANE_1, 'tab1', 'w1'),
        providerSession: { key: 'session_id', id: 'session-a' }
      },
      worktreeId: 'w1',
      tab: retainedTab,
      agentType: 'claude',
      startedAt: NOW - 10_000
    }
    const initial: DashboardSnapshotState = {
      ...baseState(),
      tabsByWorktree: { w1: [retainedTab], w2: [tab('tab2', 'w2')] },
      agentStatusByPaneKey: { [PANE_2]: entry(PANE_2, 'tab2', 'w2') },
      retainedAgentsByPaneKey: { [PANE_1]: retained }
    }
    expect(
      buildDashboardSnapshot(initial, NOW, { rowsCache: cache, rowsGeneration: 1 }).cards.find(
        (card) => card.paneKey === PANE_1
      )?.conversationName
    ).toBeUndefined()

    const titled: DashboardSnapshotState = {
      ...initial,
      tabsByWorktree: {
        ...initial.tabsByWorktree,
        w1: [
          {
            ...retainedTab,
            aiVaultTitle: { agent: 'claude', sessionId: 'session-a', title: 'Provider title' }
          }
        ]
      }
    }
    const refreshed = buildDashboardSnapshot(titled, NOW, {
      rowsCache: cache,
      rowsGeneration: 1
    })

    expect(cache.lastComputedWorktreeIds).toEqual(['w1'])
    expect(refreshed.cards.find((card) => card.paneKey === PANE_1)?.conversationName).toBe(
      'Provider title'
    )
  })
})

const initialStoreState = useAppStore.getState()
const noop = () => {}
function PopoutFixture() {
  useDashboardPopoutBridge(true)
  const snapshot = useDashboardSnapshot()
  return createElement(
    TooltipProvider,
    null,
    createElement(
      Fragment,
      null,
      ...snapshot.cards.map((card) =>
        createElement(
          'section',
          { key: card.paneKey, 'data-testid': card.tabId },
          createElement(AgentKanbanCard, { card, now: NOW, onOpenTerminal: noop }),
          card.tabId === 'tab1'
            ? createElement(AgentTerminalPanel, { card, onOpenChange: noop, onReveal: noop })
            : null
        )
      )
    )
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'api')
  iconRender.mockClear()
})

describe('native status publication to a mounted popout', () => {
  it.each(['local', 'runtime:server-1'] as const)(
    'delivers latest turns from %s without incidental input changes',
    async (executionHostId) => {
      vi.useFakeTimers()
      vi.setSystemTime(NOW)
      useAppStore.setState(initialStoreState, true)
      const nativeTab = (
        id: string,
        worktreeId: string,
        agent: 'claude' | 'codex',
        host: ExecutionHostId = executionHostId
      ) =>
        ({
          id,
          worktreeId,
          groupId: 'group',
          contentType: 'agent-session' as const,
          entityId: id,
          label: id,
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: NOW,
          isPinned: false,
          agentSessionAgent: agent,
          executionHostId: host
        }) satisfies StructuredTab
      const target = nativeTab('tab1', 'w1', 'claude')
      const other = nativeTab('tab2', 'w2', 'codex', 'runtime:other')
      useAppStore.setState({
        ...baseState(),
        tabsByWorktree: {},
        agentStatusByPaneKey: {},
        worktreesByRepo: {
          r1: [
            { ...worktree('w1'), hostId: executionHostId },
            { ...worktree('w2'), hostId: 'runtime:other' }
          ]
        },
        unifiedTabsByWorktree: { w1: [target], w2: [other] },
        terminalLayoutsByTabId: {},
        ptyIdsByTabId: {},
        runtimePaneTitlesByTabId: {},
        refreshGitHubForWorktreeIfStale: async () => {},
        setGeneratedTabTitleFromAgentPrompt: () => {}
      })
      const update = (
        tab: ReturnType<typeof nativeTab>,
        status: AgentSessionStatusSummary['status'],
        turnOutcome?: AgentSessionStatusSummary['turnOutcome'],
        backgroundTasks?: AgentSessionStatusSummary['backgroundTasks']
      ) =>
        useAppStore.getState().transactAgentStatuses((transaction) =>
          projectStatus(
            transaction,
            tab,
            {
              sessionId: tab.entityId,
              workspaceId: tab.worktreeId,
              agent: tab.agentSessionAgent,
              status,
              hostExecutionOwned: true,
              latestPrompt: 'fixed prompt',
              providerSession: { key: 'session_id', id: tab.entityId },
              updatedAt: Date.now(),
              turnOutcome,
              backgroundTasks
            },
            'live',
            null
          )
        )
      update(target, 'idle', 'success')
      update(other, 'idle', 'success')
      let openChanged: (open: boolean) => void = noop
      let receive: (snapshot: DashboardSnapshot) => void = noop
      const build = vi.spyOn(snapshotBuilder, 'buildDashboardSnapshot')
      const publish = vi.fn(async (snapshot: DashboardSnapshot) => {
        const admitted = admitDashboardSnapshot(snapshot)
        expect(admitted?.droppedCardCount).toBe(0)
        receive(admitted!.snapshot)
      })
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          dashboard: {
            onRevealAgent: () => noop,
            onAckAgent: () => noop,
            onPopoutOpenChanged: (listener: typeof openChanged) => {
              openChanged = listener
              return noop
            },
            onSnapshotRequested: () => noop,
            getPopoutOpen: async () => true,
            onSnapshot: (listener: typeof receive) => {
              receive = listener
              return noop
            },
            requestSnapshot: async () => {},
            publishSnapshot: publish
          },
          agentStatus: { onSet: () => noop, onClear: () => noop }
        }
      })
      const mounted = render(createElement(PopoutFixture))
      await act(async () => {})
      expect(within(screen.getByTestId('tab1')).getByLabelText('Done')).toBeTruthy()
      iconRender.mockClear()
      publish.mockClear()
      build.mockClear()
      await act(async () => useAppStore.setState({ sidebarWidth: 333 }))
      await act(async () => vi.advanceTimersByTime(250))
      expect(build).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
      expect(iconRender).not.toHaveBeenCalled()
      for (const [outcome, label] of [
        ['failure', 'Failed'],
        ['cancellation', 'Interrupted'],
        ['unconfirmed', 'Couldn’t confirm']
      ] as const) {
        iconRender.mockClear()
        publish.mockClear()
        build.mockClear()
        await act(async () => update(target, 'working'))
        await act(async () => vi.advanceTimersByTime(250))
        expect(within(screen.getByTestId('tab1')).getByLabelText('Working')).toBeTruthy()
        await act(async () => update(target, 'idle', outcome))
        await act(async () => vi.advanceTimersByTime(250))
        expect(within(screen.getByTestId('tab1')).getByLabelText(label)).toBeTruthy()
        expect(within(screen.getByTestId('tab1')).getByText(`Claude · ${label}`)).toBeTruthy()
        expect(iconRender.mock.calls.map((call) => call[0])).toEqual(['claude', 'claude'])
        expect(build).toHaveBeenCalledTimes(2)
        expect(publish).toHaveBeenCalledTimes(2)
      }
      iconRender.mockClear()
      await act(async () => update(other, 'working'))
      await act(async () => vi.advanceTimersByTime(250))
      expect(iconRender.mock.calls.map((call) => call[0])).toEqual(['codex'])
      await act(async () => update(target, 'idle', 'failure'))
      await act(async () => vi.advanceTimersByTime(250))
      expect(within(screen.getByTestId('tab1')).getByLabelText('Failed')).toBeTruthy()
      await act(async () =>
        update(target, 'idle', 'success', [{ id: 'job', kind: 'command', state: 'working' }])
      )
      await act(async () => vi.advanceTimersByTime(250))
      expect(
        within(screen.getByTestId('tab1')).getByLabelText('Monitoring background tasks')
      ).toBeTruthy()
      build.mockClear()
      publish.mockClear()
      await act(async () => update(target, 'working'))
      await act(async () => {
        vi.advanceTimersByTime(1)
        update(target, 'idle', 'failure')
      })
      await act(async () => {
        vi.advanceTimersByTime(1)
        update(target, 'idle', 'cancellation')
      })
      expect(build).toHaveBeenCalledOnce()
      await act(async () => vi.advanceTimersByTime(250))
      expect(build).toHaveBeenCalledTimes(2)
      expect(publish).toHaveBeenCalledTimes(2)
      expect(within(screen.getByTestId('tab1')).getByLabelText('Interrupted')).toBeTruthy()
      await act(async () =>
        useAppStore
          .getState()
          .transactAgentStatuses((transaction) =>
            projectStatus(transaction, target, null, 'live', null)
          )
      )
      await act(async () => vi.advanceTimersByTime(250))
      expect(screen.queryByTestId('tab1')).toBeNull()
      await act(async () =>
        useAppStore
          .getState()
          .transactAgentStatuses((transaction) =>
            projectStatus(transaction, target, null, 'live', Date.now())
          )
      )
      await act(async () => vi.advanceTimersByTime(250))
      expect(within(screen.getByTestId('tab1')).getByLabelText('Failed')).toBeTruthy()
      // Queue a trailing update, close before it fires, then recover current truth on reopen.
      build.mockClear()
      publish.mockClear()
      await act(async () => update(target, 'working'))
      await act(async () => openChanged(false))
      await act(async () => update(target, 'idle', 'cancellation'))
      await act(async () => vi.advanceTimersByTime(250))
      expect(build).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
      await act(async () => openChanged(true))
      expect(build).toHaveBeenCalledOnce()
      expect(publish).toHaveBeenCalledOnce()
      expect(within(screen.getByTestId('tab1')).getByLabelText('Interrupted')).toBeTruthy()
      mounted.unmount()
      build.mockClear()
      publish.mockClear()
      await act(async () => update(target, 'working'))
      await act(async () => vi.advanceTimersByTime(250))
      expect(build).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
    }
  )

  it.each([100, 1000])(
    'keeps accepted-key discovery proportional to real mutations at %i rows',
    async (count) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      vi.setSystemTime(NOW)
      useAppStore.setState(initialStoreState, true)
      const tabs = Array.from({ length: count }, (_, i) => tab(`scale-${i}`, 'w1'))
      const entries = Object.fromEntries(
        tabs.map((t) => {
          const paneKey = makePaneKey(t.id, LEAF_1)
          return [paneKey, entry(paneKey, t.id, 'w1')]
        })
      )
      useAppStore.setState({
        ...baseState(),
        tabsByWorktree: { w1: tabs },
        agentStatusByPaneKey: entries,
        terminalLayoutsByTabId: Object.fromEntries(
          tabs.map((t) => [
            t.id,
            {
              root: { type: 'leaf' as const, leafId: LEAF_1 },
              activeLeafId: LEAF_1,
              expandedLeafId: null,
              ptyIdsByLeafId: { [LEAF_1]: t.ptyId! }
            }
          ])
        ),
        ptyIdsByTabId: Object.fromEntries(tabs.map((t) => [t.id, [t.ptyId!]])),
        refreshGitHubForWorktreeIfStale: async () => {},
        setGeneratedTabTitleFromAgentPrompt: () => {}
      })
      const paneKey = makePaneKey(tabs[0].id, LEAF_1)
      const measure = async () => {
        let reads = 0
        let enumerations = 0
        const started = performance.now()
        for (let i = 0; i < 10; i++) {
          const rows = useAppStore.getState().agentStatusByPaneKey
          useAppStore.setState({
            agentStatusByPaneKey: new Proxy(rows, {
              get(target, key, receiver) {
                if (typeof key === 'string') {
                  reads++
                }
                // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
                return Reflect.get(target, key, receiver)
              },
              ownKeys(target) {
                enumerations++
                return Reflect.ownKeys(target)
              }
            })
          })
          await act(async () =>
            useAppStore.getState().transactAgentStatuses((transaction) => {
              transaction.apply({
                paneKey,
                payload: { state: 'working', prompt: 'fixed', agentType: 'claude' },
                timing: { updatedAt: NOW + i + 1 }
              })
            })
          )
        }
        return { reads, enumerations, milliseconds: performance.now() - started }
      }
      const baseline = await measure()
      useAppStore.setState({ agentStatusByPaneKey: entries })
      const build = vi.spyOn(snapshotBuilder, 'buildDashboardSnapshot')
      const publish = vi.fn(async () => {})
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          dashboard: {
            onRevealAgent: () => noop,
            onAckAgent: () => noop,
            onPopoutOpenChanged: () => noop,
            onSnapshotRequested: () => noop,
            getPopoutOpen: async () => true,
            publishSnapshot: publish
          }
        }
      })
      function Publisher() {
        useDashboardPopoutBridge(true)
        return null
      }
      const mounted = render(createElement(Publisher))
      await act(async () => {})
      expect(build.mock.results[0].value.cards).toHaveLength(count)
      build.mockClear()
      publish.mockClear()
      const accepted = vi.fn()
      const dispose = useAppStore.getState().subscribeAgentStatusChanges(accepted)
      const observed = await measure()
      expect(observed.enumerations).toBe(baseline.enumerations)
      expect(observed.reads - baseline.reads).toBe(10)
      expect(accepted).toHaveBeenCalledTimes(10)
      expect(
        accepted.mock.calls.every(
          ([changes]) => changes.length === 1 && changes[0].paneKey === paneKey
        )
      ).toBe(true)
      await act(async () => vi.advanceTimersByTime(250))
      expect(build).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
      const publisherBuilds = build.mock.calls.length
      const snapshotStarted = performance.now()
      const snapshot = buildDashboardSnapshot(
        { ...useAppStore.getState(), chatNames: new Map() },
        NOW
      )
      const snapshotMs = performance.now() - snapshotStarted
      expect(snapshot.cards).toHaveLength(count)
      console.info('accepted status production trigger benchmark', {
        rows: count,
        updates: 10,
        baseline,
        observed,
        addedDiscoveryReads: observed.reads - baseline.reads,
        acceptedKeys: 10,
        publisherBuilds,
        publications: publish.mock.calls.length,
        snapshotCards: snapshot.cards.length,
        snapshotMs
      })
      dispose()
      mounted.unmount()
    }
  )
})
