import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { buildDashboardSnapshot } from './build-dashboard-snapshot'
import { createDashboardSnapshotReuse } from './dashboard-snapshot-reuse'
import * as cardHost from './dashboard-snapshot-workspaces'

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
      id, repoId: 'r', path: `/r/${id}`, head: 'abc', branch: 'main',
      isBare: false, isMainWorktree: false, displayName: id, comment: '',
      linkedIssue: null, linkedPR: null, linkedLinearIssue: null,
      isArchived: false, isUnread: false, isPinned: false, sortOrder: index, lastActivityAt: NOW
    })
    tabs[id] = [{ id: tabId, worktreeId: id, ptyId: null, title: 'agent', customTitle: null,
      color: null, sortOrder: 0, createdAt: NOW }]
    const paneKey = makePaneKey(tabId, LEAF)
    entries.push([paneKey, { paneKey, tabId, worktreeId: id, state: 'working', prompt: 'task',
      updatedAt: NOW, stateStartedAt: NOW - 1000, stateHistory: [], agentType: 'claude' }])
  }
  store.setState({
    repos: [{ id: 'r', path: '/r', displayName: 'Repo', badgeColor: '#000', addedAt: NOW }],
    worktreesByRepo: { r: worktrees }, tabsByWorktree: tabs,
    agentStatusByPaneKey: acceptedAgentStatuses(entries)
  })
  return store
}

function update(store: ReturnType<typeof createTestStore>, key: string, state: AgentStatusEntry['state']) {
  const before = store.getState().agentStatusByPaneKey.get(key)!
  store.setState({ agentStatusByPaneKey: store.getState().agentStatusByPaneKey.replace([
    [key, { ...before, state, updatedAt: before.updatedAt + 1 }]
  ]) })
}

afterEach(() => vi.restoreAllMocks())

describe('dashboard incremental snapshot contract', () => {
  it('keeps pane visits flat at 100 and 1000 workspaces and matches full snapshots', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const visits: number[] = []
    for (const size of [100, 1000]) {
      const store = fleet(size)
      const reuse = createDashboardSnapshotReuse()
      const input = () => ({ ...store.getState(), chatNames: names })
      buildDashboardSnapshot(input(), NOW, { reuse })
      const host = vi.spyOn(cardHost, 'dashboardCardMapWorkspaceMetadata')
      host.mockClear()
      const key = makePaneKey('t0', LEAF)
      update(store, key, 'waiting')
      const cached = buildDashboardSnapshot(input(), NOW, { reuse })
      visits.push(host.mock.calls.length)
      host.mockRestore()
      expect(cached).toEqual(buildDashboardSnapshot(input(), NOW))
      expect(cached.cards.find((card) => card.paneKey === key)?.dotState).toBe('waiting')
      for (const state of ['working', 'done', 'blocked', 'working'] as const) {
        update(store, key, state)
        expect(buildDashboardSnapshot(input(), NOW, { reuse })).toEqual(buildDashboardSnapshot(input(), NOW))
      }
      // A reader falling behind the bounded journal recovers from authoritative inputs.
      for (let index = 0; index < 20; index++) {
        update(store, key, index % 2 ? 'working' : 'waiting')
      }
      expect(buildDashboardSnapshot(input(), NOW, { reuse })).toEqual(buildDashboardSnapshot(input(), NOW))
      store.setState({ acknowledgedAgentsByPaneKey: { [key]: NOW } })
      expect(buildDashboardSnapshot(input(), NOW, { reuse })).toEqual(buildDashboardSnapshot(input(), NOW))
      store.setState({ agentStatusByPaneKey: store.getState().agentStatusByPaneKey.replace([[key, null]]) })
      expect(buildDashboardSnapshot(input(), NOW, { reuse })).toEqual(buildDashboardSnapshot(input(), NOW))
      store.setState({ agentStatusByPaneKey: store.getState().agentStatusByPaneKey.capture() })
      expect(buildDashboardSnapshot(input(), NOW, { reuse })).toEqual(buildDashboardSnapshot(input(), NOW))
      expect(buildDashboardSnapshot(input(), NOW, { reuse, includeCardDetails: false })).toEqual(
        buildDashboardSnapshot(input(), NOW, { includeCardDetails: false })
      )
      update(store, makePaneKey('t1', LEAF), 'blocked')
      expect(buildDashboardSnapshot(input(), NOW, { reuse, includeCardDetails: false })).toEqual(
        buildDashboardSnapshot(input(), NOW, { includeCardDetails: false })
      )
    }
    expect(visits).toEqual([2, 2])
  })
})
