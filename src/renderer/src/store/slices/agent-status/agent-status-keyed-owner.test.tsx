// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppStateViewContext } from '../../retained-views/app-state-view'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../../terminals/terminal-tab.test-fixture'
import { makeWorktree } from '../worktrees/worktree.test-fixture'
import { TEST_REPO } from '../../repos/repo.test-fixture'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots
} from '@/runtime/web-session-tabs-sync/snapshot-api'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-types'
import { resetWebSessionTabsSyncTestState } from '@/runtime/web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'
import { useAgentStatus } from '@/runtime/agent-status/use-agent-status'
import { useAgentBucketCounts } from '@/components/dashboard/useAgentBucketCounts'
import { acceptedAgentStatuses, AcceptedAgentStatuses } from './accepted-agent-statuses'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'

const NOW = 1_800_000_000_000
const LEAF = '11111111-1111-4111-8111-111111111111'
const keyFor = (index: number) => `tab-${index}:${LEAF}`
afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fleet(active: number, sleeping: number) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  const store = createTestStore()
  const worktree = makeWorktree({ id: 'worktree', repoId: TEST_REPO.id })
  const tabs = Array.from({ length: active + sleeping }, (_, index) =>
    makeTab({ id: `tab-${index}`, worktreeId: worktree.id })
  )
  const entries = tabs.map((tab, index): readonly [string, AgentStatusEntry] => [
    keyFor(index),
    {
      paneKey: keyFor(index),
      tabId: tab.id,
      worktreeId: worktree.id,
      agentType: 'claude',
      state: index < active ? 'working' : 'done',
      prompt: 'Task',
      updatedAt: NOW,
      stateStartedAt: NOW,
      stateHistory: [],
      ...(index >= active ? { paneSleep: { ptyId: `pty-${index}` } } : {})
    }
  ])
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: [worktree] },
    tabsByWorktree: { [worktree.id]: tabs },
    terminalLayoutsByTabId: Object.fromEntries(
      tabs.map((tab) => [
        tab.id,
        { root: { type: 'leaf' as const, leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
      ])
    ),
    ptyIdsByTabId: Object.fromEntries(
      tabs.slice(0, active).map((tab) => [tab.id, [`pty-${tab.id}`]])
    ),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    agentStatusByPaneKey: acceptedAgentStatuses(entries)
  })
  store.getState().scheduleAgentStatusFreshness()
  return store
}

describe('accepted keyed owner', () => {
  it.each([750, 7500])(
    'routes paired presentation updates past %i unrelated sleeping rows',
    (sleeping) => {
      const store = fleet(1, sleeping)
      const mirror = toWebTerminalSurfaceTabId('host-tab')
      const remoteKey = `${mirror}:${LEAF}`
      const snapshot = (
        version: number,
        title: string,
        terminal: string
      ): RuntimeMobileSessionTabsResult => ({
        worktree: 'paired-worktree',
        publicationEpoch: 'paired-epoch',
        snapshotVersion: version,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: `host-tab::${LEAF}`,
            parentTabId: 'host-tab',
            leafId: LEAF,
            status: 'ready',
            terminal,
            title,
            isActive: false,
            agentStatus: {
              paneKey: `host-tab:${LEAF}`,
              tabId: 'host-tab',
              worktreeId: 'paired-worktree',
              state: 'working',
              prompt: 'Remote task',
              updatedAt: NOW,
              stateStartedAt: NOW,
              stateHistory: [],
              agentType: 'codex'
            }
          }
        ]
      })
      resetWebSessionTabsSyncTestState()
      store.setState(
        applyWebSessionTabsSnapshot(store.getState(), snapshot(1, 'Old', 'remote-1'), 'paired', NOW)
      )
      store.setState({
        runtimePaneTitlesByTabId: {
          ...Object.fromEntries(
            Array.from({ length: sleeping + 1 }, (_, i) => [`tab-${i}`, { 1: 'Done' }])
          ),
          [mirror]: { 1: 'Old' }
        }
      })
      const projection = store.getState().agentStatusByPaneKey.projection
      const unchanged = projection.row(keyFor(sleeping))
      const notices = vi.fn()
      const stop = store.getState().agentStatusByPaneKey.subscribe(keyFor(sleeping), notices)
      const iterations = vi.spyOn(AcceptedAgentStatuses.prototype, 'entries')
      const reads = vi.spyOn(AcceptedAgentStatuses.prototype, 'get')
      try {
        store.setState(
          applyWebSessionTabsSnapshot(
            store.getState(),
            snapshot(2, 'New', 'remote-2'),
            'paired',
            NOW
          )
        )
        expect(store.getState().runtimePaneTitlesByTabId[mirror]).toEqual({ 1: 'New' })
        expect(store.getState().ptyIdsByTabId[mirror]).toEqual(['remote:paired@@remote-2'])
        store.setState(
          applyWebSessionTabsSnapshots(
            store.getState(),
            [snapshot(3, 'Batch one', 'remote-3'), snapshot(4, 'Batch two', 'remote-4')],
            'paired',
            NOW
          )
        )
        expect(store.getState().runtimePaneTitlesByTabId[mirror]).toEqual({ 1: 'Batch two' })
        expect(store.getState().ptyIdsByTabId[mirror]).toEqual(['remote:paired@@remote-4'])
        expect(projection.row(keyFor(sleeping))).toBe(unchanged)
        expect(notices).not.toHaveBeenCalled()
        expect(iterations).not.toHaveBeenCalled()
        expect(new Set(reads.mock.calls.map(([key]) => key))).toEqual(new Set([remoteKey]))
      } finally {
        stop()
        resetWebSessionTabsSyncTestState()
      }
    }
  )

  it.each([499, 750])(
    'does not evict other conversations because %i panes are asleep',
    (sleeping) => {
      const store = fleet(0, sleeping)
      const first = {
        paneKey: 'native-a:session-a',
        state: 'done' as const,
        prompt: 'Completed chat',
        updatedAt: NOW,
        stateStartedAt: NOW,
        stateHistory: [],
        terminalResumeEligible: false as const
      }
      const second = {
        ...first,
        paneKey: 'native-b:session-b',
        state: 'working' as const,
        prompt: 'Active chat'
      }
      store.setState({
        agentStatusByPaneKey: store.getState().agentStatusByPaneKey.replace([
          [first.paneKey, first],
          [second.paneKey, second]
        ])
      })
      store.getState().setAgentStatus(second.paneKey, { state: 'working', prompt: 'Progress' })
      expect(store.getState().agentStatusByPaneKey.get(first.paneKey)).toBe(first)
      expect(store.getState().agentStatusByPaneKey.get(second.paneKey)?.prompt).toBe('Progress')
      expect(store.getState().agentStatusByPaneKey.awakeSize).toBe(2)
      expect(store.getState().agentStatusByPaneKey.size).toBe(sleeping + 2)
    }
  )

  it.each([100, 1000])('prepares each of %i rooted batch updates once', (active) => {
    const store = fleet(active, active * 7.5)
    const before = store.getState().agentStatusByPaneKey.capture()
    const reads = vi.spyOn(AcceptedAgentStatuses.prototype, 'get')
    store.getState().transactAgentStatuses((transaction) => {
      for (let index = 0; index < active; index++) {
        transaction.apply({
          paneKey: keyFor(index),
          payload: { state: 'working', prompt: 'Progress' },
          timing: { updatedAt: NOW + 1 }
        })
      }
    })
    expect(reads.mock.calls.length).toBeLessThan(active * 40)
    expect(store.getState().agentStatusByPaneKey.size).toBe(active * 8.5)
    expect(store.getState().agentStatusByPaneKey.get(keyFor(active - 1))?.prompt).toBe('Progress')
    expect(before.get(keyFor(active - 1))?.prompt).toBe('Task')
  })

  it.each([100, 1000])(
    'publishes presentation provenance once for %i paired snapshots',
    (count) => {
      resetWebSessionTabsSyncTestState()
      const store = fleet(1, 750)
      store.setState({
        runtimePaneTitlesByTabId: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            toWebTerminalSurfaceTabId(`host-${index}`),
            { 1: 'Before' }
          ])
        )
      })
      const provenanceWrites = vi.spyOn(WeakMap.prototype, 'set')
      const snapshots = Array.from(
        { length: count },
        (_, index): RuntimeMobileSessionTabsResult => ({
          worktree: `paired-${index}`,
          publicationEpoch: `epoch-${index}`,
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `host-${index}::${LEAF}`,
              parentTabId: `host-${index}`,
              leafId: LEAF,
              status: 'ready',
              terminal: `remote-${index}`,
              title: 'Remote',
              isActive: false
            }
          ]
        })
      )
      try {
        store.setState(applyWebSessionTabsSnapshots(store.getState(), snapshots, 'paired', NOW))
        expect(
          store.getState().ptyIdsByTabId[toWebTerminalSurfaceTabId(`host-${count - 1}`)]
        ).toEqual([`remote:paired@@remote-${count - 1}`])
        expect(
          store.getState().runtimePaneTitlesByTabId[toWebTerminalSurfaceTabId(`host-${count - 1}`)]
        ).toEqual({ 1: 'Remote' })
        const published = new Set<unknown>([
          store.getState().ptyIdsByTabId,
          store.getState().terminalLayoutsByTabId,
          store.getState().runtimePaneTitlesByTabId
        ])
        const addressedWrites = provenanceWrites.mock.calls.filter(
          ([record, value]) =>
            published.has(record) &&
            value &&
            typeof value === 'object' &&
            'previous' in value &&
            'keys' in value
        )
        // One accepted provenance link per output; repeating a cumulative link per input is quadratic.
        expect(addressedWrites).toHaveLength(3)
      } finally {
        resetWebSessionTabsSyncTestState()
      }
    }
  )

  it('keeps an explicit captured view across later writes and removals', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const store = fleet(2, 1)
    const view = store.getState().agentStatusByPaneKey.capture()
    const rows = view.projection.list('worktree')
    const counts = view.projection.dashboardCounts()
    store.getState().setAgentStatus(keyFor(0), { state: 'done', prompt: 'Finished' })
    store.getState().removeAgentStatus(keyFor(2))
    expect(view.get(keyFor(0))?.state).toBe('working')
    expect(view.get(keyFor(2))?.state).toBe('done')
    expect(view.projection.list('worktree')).toBe(rows)
    expect(view.projection.dashboardCounts()).toBe(counts)
    expect(counts).toEqual({ attention: 0, working: 2, done: 1, idle: 0 })
  })

  it.each([
    [100, 750],
    [1000, 7500]
  ])(
    'updates one row and four totals without reading unrelated facts (%i active/%i asleep)',
    (active, sleeping) => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW)
      const store = fleet(active, sleeping)
      const renders = { changed: 0, other: 0, counts: 0 }
      function Row({ index, name }: { index: number; name: 'changed' | 'other' }) {
        const row = useAgentStatus(keyFor(index))
        renders[name]++
        return <span>{row?.state}</span>
      }
      function Counts() {
        const counts = useAgentBucketCounts()
        renders.counts++
        return <span>{counts.attention}</span>
      }
      render(
        <AppStateViewContext.Provider value={store}>
          <Row index={0} name="changed" />
          <Row index={1} name="other" />
          <Counts />
        </AppStateViewContext.Provider>
      )
      renders.changed = 0
      renders.other = 0
      renders.counts = 0
      const iterations = vi.spyOn(AcceptedAgentStatuses.prototype, 'entries')
      const reads = vi.spyOn(AcceptedAgentStatuses.prototype, 'get')
      const fullOutput = vi.spyOn(store.getState().agentStatusByPaneKey.projection, 'list')
      act(() =>
        store.getState().setAgentStatus(keyFor(0), { state: 'working', prompt: 'Progress' })
      )
      expect(renders).toEqual({ changed: 1, other: 0, counts: 0 })
      renders.changed = 0
      act(() =>
        store.getState().setAgentStatus(keyFor(0), { state: 'blocked', prompt: 'Needs approval' })
      )
      expect(renders).toEqual({ changed: 1, other: 0, counts: 1 })
      expect(store.getState().agentStatusByPaneKey.projection.dashboardCounts()).toEqual({
        attention: 1,
        working: active - 1,
        done: sleeping,
        idle: 0
      })
      expect(iterations).not.toHaveBeenCalled()
      expect(fullOutput).not.toHaveBeenCalled()
      // The trigger changes one key. Reading any other accepted fact would violate that scope at either population.
      expect(new Set(reads.mock.calls.map(([key]) => key))).toEqual(new Set([keyFor(0)]))
    }
  )
})
