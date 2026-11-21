import { describe, expect, it } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { getIndexedWorktreeMap } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { buildActivityEvents, type BuildActivityEventsArgs } from '../events/activity-event-builder'
import { createActivityEventBuildCache } from '../events/activity-event-build-cache'
import { countActivityUnread } from '../events/useActivityUnreadCount'
import { buildAgentPaneThreads, createAgentPaneThreadReuseCache } from './activity-thread-builder'

const NOW = 1_000_000_000
const MINUTE = 60_000
const LEAF = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const names = new Map()
const STATES = ['working', 'done', 'waiting'] as const

type Store = ReturnType<typeof createTestStore>

function fleet(size: number): Store {
  const store = createTestStore()
  const worktrees: AppState['worktreesByRepo'][string] = []
  const tabs: AppState['tabsByWorktree'] = {}
  const ptyIdsByTabId: AppState['ptyIdsByTabId'] = {}
  const entries: [string, AgentStatusEntry][] = []
  for (let index = 0; index < size; index++) {
    const id = `w${index}`
    const tabId = `t${index}`
    const ptyId = index % 2 ? null : `pty-${index}`
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
        ptyId,
        title: 'agent',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: NOW
      }
    ]
    if (ptyId) {
      ptyIdsByTabId[tabId] = [ptyId]
    }
    const paneKey = makePaneKey(tabId, LEAF)
    // Equal start times tie panes across the global cap; staggered evidence decays at different instants.
    const historyAt = NOW - 40_000 - (index % 7) * 1000
    entries.push([
      paneKey,
      {
        paneKey,
        tabId,
        worktreeId: id,
        state: STATES[index % 3],
        prompt: `task ${index}`,
        updatedAt: NOW - (index % 5) * 10 * MINUTE,
        stateStartedAt: NOW - 1000,
        stateHistory:
          index % 2
            ? []
            : [
                {
                  state: 'done',
                  prompt: 'earlier',
                  startedAt: historyAt - 1000,
                  observedAt: historyAt - 1000
                },
                { state: 'waiting', prompt: 'earlier', startedAt: historyAt, observedAt: historyAt }
              ],
        agentType: 'claude'
      }
    ])
  }
  store.setState({
    repos: [{ id: 'r', path: '/r', displayName: 'Repo', badgeColor: '#000', addedAt: NOW }],
    worktreesByRepo: { r: worktrees },
    tabsByWorktree: tabs,
    ptyIdsByTabId,
    agentStatusByPaneKey: acceptedAgentStatuses(entries),
    // One unsupported row shares a live pane (first source wins), one stands alone.
    migrationUnsupportedByPtyId: {
      'legacy-1': {
        ptyId: 'legacy-1',
        paneKey: makePaneKey('t1', LEAF),
        reason: 'legacy-numeric-pane-key',
        source: 'local',
        updatedAt: NOW - 100_000
      },
      'legacy-2': {
        ptyId: 'legacy-2',
        paneKey: makePaneKey('t2', LEAF_2),
        reason: 'legacy-numeric-pane-key',
        source: 'local',
        updatedAt: NOW - 90_000
      }
    }
  })
  return store
}

function inputs(store: Store, now: number): BuildActivityEventsArgs {
  const s = store.getState()
  return {
    chatNames: names,
    agentStatusByPaneKey: s.agentStatusByPaneKey,
    runtimeAgentOrchestrationByPaneKey: s.runtimeAgentOrchestrationByPaneKey,
    migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
    tabsByWorktree: s.tabsByWorktree,
    ptyIdsByTabId: s.ptyIdsByTabId,
    unifiedTabsByWorktree: s.unifiedTabsByWorktree,
    worktreeMap: getIndexedWorktreeMap(s.worktreesByRepo),
    repoMap: getIndexedRepoMap(s.repos),
    repos: s.repos,
    resolveWorktree: s.getKnownWorktreeById,
    resolveWorktreeInputs: [
      s.worktreesByRepo,
      s.folderWorkspaces,
      s.projectGroups,
      s.repos,
      s.detectedWorktreesByRepo,
      s.floatingWorkspacePath
    ],
    acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey,
    activityClearedAtByPaneKey: s.activityClearedAtByPaneKey,
    now
  }
}

function builder(store: Store) {
  const events = createActivityEventBuildCache()
  const threads = createAgentPaneThreadReuseCache()
  const run = (now: number, cached: boolean, statuses?: AppState['agentStatusByPaneKey']) => {
    const args = inputs(store, now)
    const built = buildActivityEvents(
      statuses ? { ...args, agentStatusByPaneKey: statuses } : args,
      cached ? events : undefined
    )
    return {
      ...built,
      threads: buildAgentPaneThreads(
        { ...built, generatedTitlesEnabled: true },
        cached ? threads : undefined
      )
    }
  }
  return {
    cached: (now = NOW) => run(now, true),
    full: (now = NOW) => run(now, false),
    expectEquivalent(now = NOW, statuses?: AppState['agentStatusByPaneKey']) {
      expect(run(now, true, statuses)).toEqual(run(now, false, statuses))
    }
  }
}

function write(store: Store, replacements: [string, AgentStatusEntry | null][]): void {
  store.setState({
    agentStatusByPaneKey: store.getState().agentStatusByPaneKey.replace(replacements)
  })
}

function ping(store: Store, key: string, patch: Partial<AgentStatusEntry> = {}): void {
  const before = store.getState().agentStatusByPaneKey.get(key)!
  write(store, [[key, { ...before, updatedAt: before.updatedAt + 1, ...patch }]])
}

describe('Activity incremental build', () => {
  it('keeps cached events and threads current after status and ownership changes', () => {
    const store = fleet(100)
    const build = builder(store)
    build.cached()
    const key = makePaneKey('t0', LEAF)
    ping(store, key)
    build.expectEquivalent()

    ping(store, key, { state: 'waiting', stateStartedAt: NOW - 500 })
    expect(build.cached().events.find((event) => event.entry.paneKey === key)).toMatchObject({
      state: 'waiting',
      entry: { prompt: 'task 0' }
    })
    build.expectEquivalent()
    for (const state of ['done', 'blocked', 'working'] as const) {
      ping(store, key, { state, stateStartedAt: NOW - 500 })
      build.expectEquivalent()
    }
    // Add, remove, and move a pane to the end of status order, which reorders cap ties.
    write(store, [
      [
        makePaneKey('t3', LEAF_2),
        {
          ...store.getState().agentStatusByPaneKey.get(makePaneKey('t3', LEAF))!,
          paneKey: makePaneKey('t3', LEAF_2)
        }
      ]
    ])
    build.expectEquivalent()
    write(store, [[makePaneKey('t5', LEAF), null]])
    build.expectEquivalent()
    const moved = store.getState().agentStatusByPaneKey.get(makePaneKey('t1', LEAF))!
    write(store, [[makePaneKey('t1', LEAF), null]])
    write(store, [[makePaneKey('t1', LEAF), moved]])
    build.expectEquivalent()
    write(store, [
      [makePaneKey('t2', LEAF), null],
      [
        makePaneKey('t2', LEAF),
        {
          ...store.getState().agentStatusByPaneKey.get(makePaneKey('t2', LEAF))!,
          updatedAt: NOW + 2
        }
      ]
    ])
    build.expectEquivalent()

    // Freshness lapses with or without a status write; a backwards clock rebuilds.
    for (const now of [NOW + 1, NOW + 15 * MINUTE, NOW + 31 * MINUTE, NOW]) {
      build.expectEquivalent(now)
      ping(store, key)
      build.expectEquivalent(now)
    }
    // A reader behind the bounded journal recovers from authoritative inputs.
    for (let index = 0; index < 20; index++) {
      ping(store, key, { state: index % 2 ? 'working' : 'waiting' })
    }
    build.expectEquivalent()
    store.setState({ acknowledgedAgentsByPaneKey: { [key]: NOW } })
    build.expectEquivalent()
    store.setState({ activityClearedAtByPaneKey: { [makePaneKey('t4', LEAF)]: NOW } })
    build.expectEquivalent()
    store.setState({ migrationUnsupportedByPtyId: {} })
    build.expectEquivalent()
    // Another status owner, such as a captured view, never reuses this owner's panes.
    build.cached()
    build.expectEquivalent(NOW, store.getState().agentStatusByPaneKey.capture())
    build.expectEquivalent()
  })

  it('drops a finished pane from the list and unread count once its tab closes', () => {
    const store = fleet(3)
    store.setState({ migrationUnsupportedByPtyId: {} })
    const listed = () =>
      new Set(
        builder(store)
          .full()
          .events.map((event) => event.entry.paneKey)
      )
    const working = makePaneKey('t0', LEAF)
    const done = makePaneKey('t1', LEAF)
    const waiting = makePaneKey('t2', LEAF)
    expect(listed()).toEqual(new Set([working, done, waiting]))
    expect(countActivityUnread(store.getState(), NOW)).toBe(7)

    store.setState({ tabsByWorktree: { w2: store.getState().tabsByWorktree.w2 } })
    expect(listed()).toEqual(new Set([working, waiting]))
    expect(countActivityUnread(store.getState(), NOW)).toBe(6)
  })

  it('fills the global cap with the newest pane heads, ties in status order', () => {
    const store = fleet(1000)
    const build = builder(store)
    build.cached()
    const first = makePaneKey('t1', LEAF)
    write(store, [[first, null]])
    write(store, [
      [
        first,
        {
          ...store.getState().agentStatusByPaneKey.get(makePaneKey('t4', LEAF))!,
          paneKey: first,
          tabId: 't1',
          worktreeId: 'w1',
          state: 'done'
        }
      ]
    ])
    const { events } = build.cached()
    expect(events).toEqual(build.full().events)
    // Every done/waiting pane ties at its current turn; the reserve keeps the first 80 in status order.
    const historical = Array.from(store.getState().agentStatusByPaneKey.values())
      .filter((entry) => entry.state !== 'working')
      .map((entry) => entry.paneKey)
    const kept = events
      .filter((event) => event.state !== 'working')
      .map((event) => event.entry.paneKey)
    expect(kept).toEqual(historical.slice(0, 80))
    expect(kept).not.toContain(first)
  })
})
