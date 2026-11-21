import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import {
  DASHBOARD_BUCKET_ORDER,
  type DashboardBucket,
  type DashboardSnapshot
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { buildDashboardSnapshot } from './build-dashboard-snapshot'
import { replaceDashboardCards } from './dashboard-card-changes'
import { createDashboardSnapshotReuse } from './dashboard-snapshot-reuse'
import { i18n } from '@/i18n/i18n'
import { createDashboardBoardProjection } from '../board/agent-board-projection'
import { EMPTY_DASHBOARD_FILTERS } from '../board/agent-board-filtering'

const NOW = 1_000_000_000
const LEAF = '11111111-1111-4111-8111-111111111111'
const names = new Map()

function fleet(size: number) {
  const store = createTestStore()
  const worktrees: AppState['worktreesByRepo'][string] = []
  const tabs: AppState['tabsByWorktree'] = {}
  const entries: [string, AgentStatusEntry][] = []
  for (let index = 0; index < size; index++) {
    const id = `w${index}`
    const tabId = `t${index}`
    worktrees.push({
      id,
      repoId: 'r',
      path: `/r/${id}`,
      head: 'abc',
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
      sortOrder: index,
      lastActivityAt: NOW
    })
    tabs[id] = [
      {
        id: tabId,
        worktreeId: id,
        ptyId: null,
        title: 'agent',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: NOW
      }
    ]
    const paneKey = makePaneKey(tabId, LEAF)
    entries.push([
      paneKey,
      {
        paneKey,
        tabId,
        worktreeId: id,
        state: 'working',
        prompt: 'task',
        updatedAt: NOW,
        stateStartedAt: NOW - 1000,
        stateHistory: [],
        agentType: 'claude'
      }
    ])
  }
  store.setState({
    repos: [{ id: 'r', path: '/r', displayName: 'Repo', badgeColor: '#000', addedAt: NOW }],
    worktreesByRepo: { r: worktrees },
    tabsByWorktree: tabs,
    agentStatusByPaneKey: acceptedAgentStatuses(entries)
  })
  return store
}

function update(
  store: ReturnType<typeof createTestStore>,
  key: string,
  state: AgentStatusEntry['state']
) {
  const before = store.getState().agentStatusByPaneKey.get(key)!
  store.setState({
    agentStatusByPaneKey: store
      .getState()
      .agentStatusByPaneKey.replace([[key, { ...before, state, updatedAt: before.updatedAt + 1 }]])
  })
}

afterEach(() => vi.restoreAllMocks())

describe('dashboard incremental snapshot contract', () => {
  // Child status updates exposed fleet-wide dashboard work in #45054.
  it.each([100, 1000])('keeps child status work local with %s agent cards', (size) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const store = fleet(size)
    const reuse = createDashboardSnapshotReuse()
    const read = () =>
      buildDashboardSnapshot({ ...store.getState(), chatNames: names }, NOW, { reuse })
    const key = makePaneKey('t0', LEAF)
    const publish = (description: string, updatedAt: number) => {
      const statuses = store.getState().agentStatusByPaneKey
      store.setState({
        agentStatusByPaneKey: statuses.replace([
          [
            key,
            {
              ...statuses.get(key)!,
              updatedAt,
              subagents: [
                {
                  id: 'worker',
                  description,
                  state: 'working',
                  startedAt: NOW
                }
              ]
            }
          ]
        ])
      })
    }
    publish('Initial helper', NOW)
    const before = read()
    const search = vi.fn(() => 'task')
    for (const card of before.cards.slice(1)) {
      Object.defineProperty(card, 'task', { get: search })
    }
    const project = createDashboardBoardProjection()
    const board = project(before.cards, false, 'task', EMPTY_DASHBOARD_FILTERS)
    expect(board.lanes.working.indexes).toHaveLength(size)
    expect(search).toHaveBeenCalledTimes(size - 1)
    search.mockClear()
    const projection = store.getState().agentStatusByPaneKey.projection
    const list = vi.spyOn(projection, 'list')
    publish('Renamed helper', NOW + 1)
    const next = read()
    expect(list.mock.calls).toEqual([['w0']])
    expect(projection.row(`${key}\0subagent:worker`)?.entry.prompt).toBe('Renamed helper')
    expect(next.cards.filter((card, index) => card !== before.cards[index])).toEqual([
      next.cards[0]
    ])
    expect(next.cards[0]).toMatchObject({
      statusUpdatedAt: NOW + 1,
      subagents: [{ id: `${key}\0subagent:worker`, name: 'Renamed helper', dotState: 'working' }]
    })
    const nextBoard = project(next.cards, false, 'task', EMPTY_DASHBOARD_FILTERS)
    expect(nextBoard.lanes.working).toBe(board.lanes.working)
    expect(nextBoard.lanes.working.subagentCounts[0]).toBe(1)
    expect(nextBoard.visibleCards).toBe(board.visibleCards)
    expect(search).not.toHaveBeenCalled()
  })

  // #46074 rebuilt every column's virtual layout when a working card gained a child.
  it.each([
    [100, 99],
    [1000, 999]
  ])('invalidates only changed column layouts with %s cards', (size, completedCount) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const initial = buildDashboardSnapshot({ ...fleet(size).getState(), chatNames: names }, NOW)
    initial.cards = initial.cards.map((card, index) =>
      index === 0 ? card : { ...card, bucket: 'done', dotState: 'done', stateChangedAt: NOW }
    )
    const child = { id: 'worker', name: 'Helper', dotState: 'working' as const }
    const added = {
      ...initial,
      cards: replaceDashboardCards(
        initial.cards,
        new Map([[0, { ...initial.cards[0], subagents: [child] }]])
      )
    }

    for (const [before, after] of [
      [initial, added],
      [structuredClone(initial), structuredClone(added)]
    ]) {
      const project = createDashboardBoardProjection()
      const read = (snapshot: DashboardSnapshot) =>
        project(snapshot.cards, false, '', EMPTY_DASHBOARD_FILTERS).lanes
      let lanes = read(before)
      const checkLayouts = (snapshot: DashboardSnapshot, changed: DashboardBucket[]) => {
        const next = read(snapshot)
        expect(
          DASHBOARD_BUCKET_ORDER.filter(
            (bucket) =>
              next[bucket].paneKeys !== lanes[bucket].paneKeys ||
              next[bucket].subagentCounts !== lanes[bucket].subagentCounts
          )
        ).toEqual(changed)
        lanes = next
      }
      expect(lanes.done.paneKeys).toHaveLength(completedCount)
      const workingKeys = lanes.working.paneKeys
      checkLayouts(after, ['working'])
      expect(lanes.working.paneKeys).toBe(workingKeys)
      expect(lanes.working.subagentCounts).toEqual([1])

      const [working, ...completed] = after.cards
      const renamed = structuredClone({
        ...after,
        cards: [
          ...completed,
          {
            ...working,
            subagents: [{ ...child, name: 'Renamed helper' }],
            statusUpdatedAt: NOW + 1
          }
        ]
      })
      checkLayouts(renamed, [])
      expect(lanes.working.indexes).toEqual([completedCount])
      expect(renamed.cards[lanes.working.indexes[0]]).toMatchObject({
        paneKey: working.paneKey,
        subagents: [{ name: 'Renamed helper' }],
        statusUpdatedAt: NOW + 1
      })

      const reordered = structuredClone(renamed)
      const lastCompleted = reordered.cards[completedCount - 1]
      lastCompleted.stateChangedAt = NOW + 1
      checkLayouts(reordered, ['done'])
      expect(lanes.done.paneKeys[0]).toBe(lastCompleted.paneKey)

      const moved = structuredClone(reordered)
      moved.cards[completedCount - 1] = { ...lastCompleted, bucket: 'working', dotState: 'working' }
      checkLayouts(moved, ['working', 'done'])
      expect(lanes.working.paneKeys).toEqual([lastCompleted.paneKey, working.paneKey])
    }
  })

  it('keeps a reused snapshot current as pane state and card details change', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const store = fleet(2)
    const reuse = createDashboardSnapshotReuse()
    const input = () => ({ ...store.getState(), chatNames: names })
    buildDashboardSnapshot(input(), NOW, { reuse })
    const key = makePaneKey('t0', LEAF)
    update(store, key, 'waiting')
    const cached = buildDashboardSnapshot(input(), NOW, { reuse })
    expect(cached).toEqual(buildDashboardSnapshot(input(), NOW))
    expect(cached.cards.find((card) => card.paneKey === key)?.dotState).toBe('waiting')
    for (const state of ['working', 'done', 'blocked', 'working'] as const) {
      update(store, key, state)
      expect(buildDashboardSnapshot(input(), NOW, { reuse })).toEqual(
        buildDashboardSnapshot(input(), NOW)
      )
    }
    // A reader falling behind the bounded journal recovers from authoritative inputs.
    for (let index = 0; index < 20; index++) {
      update(store, key, index % 2 ? 'working' : 'waiting')
    }
    expect(buildDashboardSnapshot(input(), NOW, { reuse })).toEqual(
      buildDashboardSnapshot(input(), NOW)
    )
    store.setState({ acknowledgedAgentsByPaneKey: { [key]: NOW } })
    expect(buildDashboardSnapshot(input(), NOW, { reuse })).toEqual(
      buildDashboardSnapshot(input(), NOW)
    )
    store.setState({
      agentStatusByPaneKey: store.getState().agentStatusByPaneKey.replace([[key, null]])
    })
    expect(buildDashboardSnapshot(input(), NOW, { reuse })).toEqual(
      buildDashboardSnapshot(input(), NOW)
    )
    store.setState({ agentStatusByPaneKey: store.getState().agentStatusByPaneKey.capture() })
    expect(buildDashboardSnapshot(input(), NOW, { reuse })).toEqual(
      buildDashboardSnapshot(input(), NOW)
    )
    expect(buildDashboardSnapshot(input(), NOW, { reuse, includeCardDetails: false })).toEqual(
      buildDashboardSnapshot(input(), NOW, { includeCardDetails: false })
    )
    update(store, makePaneKey('t1', LEAF), 'blocked')
    expect(buildDashboardSnapshot(input(), NOW, { reuse, includeCardDetails: false })).toEqual(
      buildDashboardSnapshot(input(), NOW, { includeCardDetails: false })
    )
  })
  it('keeps same-ID workspaces distinct across hosts and invalidates every occurrence', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const store = fleet(2)
    const local = store.getState().worktreesByRepo.r[0]
    store.setState({
      repos: [
        ...store.getState().repos,
        {
          id: 'remote',
          path: '/remote',
          displayName: 'Remote',
          badgeColor: '#000',
          addedAt: NOW,
          executionHostId: 'runtime:env-1'
        }
      ],
      worktreesByRepo: {
        ...store.getState().worktreesByRepo,
        remote: [
          { ...local, repoId: 'remote', displayName: 'Remote twin', hostId: 'runtime:env-1' }
        ]
      }
    })
    const reuse = createDashboardSnapshotReuse()
    const input = () => ({ ...store.getState(), chatNames: names })
    const expected = buildDashboardSnapshot(input(), NOW)
    expect(expected.workspaces?.map((workspace) => workspace.repoId)).toEqual(['r', 'r', 'remote'])
    expect(buildDashboardSnapshot(input(), NOW, { reuse })).toEqual(expected)
    expect(buildDashboardSnapshot(input(), NOW, { reuse })).toEqual(expected)
    update(store, makePaneKey('t0', LEAF), 'waiting')
    expect(buildDashboardSnapshot(input(), NOW, { reuse })).toEqual(
      buildDashboardSnapshot(input(), NOW)
    )
  })

  it('invalidates reused labels when active translation resources change without a store write', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const store = fleet(2)
    const reuse = createDashboardSnapshotReuse()
    const input = () => ({ ...store.getState(), chatNames: names })
    const language = i18n.language
    const original = structuredClone(i18n.getResourceBundle(language, 'translation'))
    const previous = buildDashboardSnapshot(input(), NOW, { reuse })
    try {
      i18n.addResourceBundle(
        language,
        'translation',
        {
          auto: {
            components: { sidebar: { workspaceBoardStatus: { todo: 'Changed catalog value' } } }
          }
        },
        true,
        true
      )
      update(store, makePaneKey('t0', LEAF), 'waiting')
      const full = buildDashboardSnapshot(input(), NOW)
      expect(full.filterOptions).not.toEqual(previous.filterOptions)
      expect(buildDashboardSnapshot(input(), NOW, { reuse })).toEqual(full)
    } finally {
      i18n.removeResourceBundle(language, 'translation')
      i18n.addResourceBundle(language, 'translation', original)
    }
  })
})
