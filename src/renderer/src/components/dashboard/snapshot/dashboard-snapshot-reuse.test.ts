import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { buildDashboardSnapshot } from './build-dashboard-snapshot'
import { createDashboardSnapshotReuse } from './dashboard-snapshot-reuse'
import { i18n } from '@/i18n/i18n'

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
