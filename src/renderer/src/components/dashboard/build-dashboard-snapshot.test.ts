import { describe, expect, it, vi } from 'vitest'
import {
  buildDashboardSnapshot,
  type DashboardSnapshotInput as DashboardSnapshotState
} from './build-dashboard-snapshot'

import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../shared/agent-status/contracts/agent-status-types'

import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { selectRuntimeAgentOrchestrationBatch } from '../sidebar/workspace-card/activity/worktree-agent-orchestration-batch'
import '../sidebar/workspace-card/activity/worktree-agent-row-selectors'
import { selectWorktreeAgentOrchestration as selectRuntimeAgentOrchestrationForWorktree } from '../sidebar/workspace-card/activity/worktree-agent-orchestration-index'
import type * as DashboardSnapshotWorkspacesModule from './dashboard-snapshot-workspaces'
import type * as AgentRowLineageModule from './agent-row-lineage'

const mapMetadataCalls = vi.hoisted(() => ({
  hostKind: vi.fn(),
  parentPaneKey: vi.fn()
}))

vi.mock('./dashboard-snapshot-workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof DashboardSnapshotWorkspacesModule>()
  return {
    ...actual,
    dashboardCardMapWorkspaceMetadata: (
      ...args: Parameters<typeof actual.dashboardCardMapWorkspaceMetadata>
    ) => {
      mapMetadataCalls.hostKind()
      return actual.dashboardCardMapWorkspaceMetadata(...args)
    }
  }
})

vi.mock('./agent-row-lineage', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentRowLineageModule>()
  return {
    ...actual,
    dashboardCardParentPaneKey: (...args: Parameters<typeof actual.dashboardCardParentPaneKey>) => {
      mapMetadataCalls.parentPaneKey()
      return actual.dashboardCardParentPaneKey(...args)
    }
  }
})

const NOW = 1_000_000_000
const TAB_ID = 'tab1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

const SPLIT_SIBLING_LEAF_ID = '55555555-5555-4555-8555-555555555555'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

function entry(overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
  return {
    paneKey: PANE_KEY,
    state: 'working',
    prompt: 'do the thing',
    updatedAt: NOW,
    stateStartedAt: NOW - 5000,
    stateHistory: [],
    agentType: 'claude',
    tabId: TAB_ID,
    worktreeId: 'w1',
    ...overrides
  }
}

function tab(id = TAB_ID, worktreeId = 'w1'): TerminalTab {
  return {
    id,
    ptyId: 'pty1',
    worktreeId,
    title: 'agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW
  }
}

function worktree(id = 'w1', displayName = 'wt-one'): Worktree {
  return {
    id,
    repoId: 'r1',
    path: `/r1/${id}`,
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName,
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

function baseState(overrides: Partial<DashboardSnapshotState>): DashboardSnapshotState {
  return {
    chatNames: new Map(),
    repos: [{ id: 'r1', path: '/r1', displayName: 'Repo One', badgeColor: '#000', addedAt: NOW }],
    worktreesByRepo: { r1: [worktree()] },
    tabsByWorktree: { w1: [tab()] },
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty1' }
      }
    },
    ptyIdsByTabId: { [TAB_ID]: ['pty1'] },
    runtimePaneTitlesByTabId: {},
    acknowledgedAgentsByPaneKey: {},
    settings: null,
    ...overrides
  }
}

describe('buildDashboardSnapshot', () => {
  it('names each pane of a split tab from its own title', () => {
    const siblingPaneKey = makePaneKey(TAB_ID, SPLIT_SIBLING_LEAF_ID)
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: {
          [PANE_KEY]: entry({}),
          [siblingPaneKey]: entry({ paneKey: siblingPaneKey })
        },
        // The tab title is whichever pane has focus, so it must not name both.
        tabsByWorktree: { w1: [{ ...tab(), title: '\u2733 Linear work log' }] },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: LEAF_ID },
              second: { type: 'leaf', leafId: SPLIT_SIBLING_LEAF_ID }
            },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_ID]: 'pty1', [SPLIT_SIBLING_LEAF_ID]: 'pty2' }
          }
        },
        ptyIdsByTabId: { [TAB_ID]: ['pty1', 'pty2'] },
        // Pane ids are replay-creation-ordered: 1 -> first leaf, 2 -> second.
        runtimePaneTitlesByTabId: {
          [TAB_ID]: { 1: '\u2733 Linear work log', 2: '\u2733 Redis cache strategy' }
        }
      }),
      NOW
    )

    const nameByPaneKey = new Map(
      snapshot.cards.map((card) => [card.paneKey, card.conversationName])
    )
    expect(nameByPaneKey.get(PANE_KEY)).toBe('Linear work log')
    expect(nameByPaneKey.get(siblingPaneKey)).toBe('Redis cache strategy')
  })

  it('nulls ptyId when the layout entry points at a dead pty', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: { [PANE_KEY]: entry({}) },
        // Layouts retain old PTY IDs after restart; only the live set proves preview availability.
        ptyIdsByTabId: { [TAB_ID]: [] }
      }),
      NOW
    )
    expect(snapshot.cards[0].ptyId).toBeNull()
  })

  it('skips card-only context for count snapshots', () => {
    mapMetadataCalls.hostKind.mockClear()
    mapMetadataCalls.parentPaneKey.mockClear()
    let linkedReviewReads = 0
    let hostIdentityReads = 0
    const countWorktree = worktree()
    Object.defineProperty(countWorktree, 'linkedPR', {
      enumerable: true,
      get: () => {
        linkedReviewReads += 1
        return null
      }
    })
    const countRepo = {
      id: 'r1',
      path: '/r1',
      displayName: 'Repo One',
      badgeColor: '#000',
      addedAt: 0,
      get connectionId() {
        hostIdentityReads += 1
        return null
      }
    }
    const snapshot = buildDashboardSnapshot(
      baseState({
        repos: [countRepo],
        worktreesByRepo: { r1: [countWorktree] },
        agentStatusByPaneKey: { [PANE_KEY]: entry({}) }
      }),
      NOW,
      { includeCardDetails: false, includeFilterOptions: false }
    )

    expect(snapshot.cards[0].workspaceStatusId).toBeUndefined()
    expect(snapshot.cards[0].subagents).toBeUndefined()
    expect(snapshot.cards[0].parentPaneKey).toBeUndefined()
    expect(snapshot.cards[0].parentWorktreeId).toBeUndefined()
    expect(snapshot.cards[0].hostKind).toBeUndefined()
    expect(snapshot.cards[0].workspaceKind).toBeUndefined()
    // A live PTY alone must not trigger host-input resolution on sidebar count rebuilds.
    expect(snapshot.cards[0].ptyId).toBe('pty1')
    expect(snapshot.cards[0].terminalInput).toBeUndefined()
    expect(snapshot.workspaces).toBeUndefined()
    expect(linkedReviewReads).toBe(0)
    expect(hostIdentityReads).toBe(0)
    expect(mapMetadataCalls.hostKind).not.toHaveBeenCalled()
    expect(mapMetadataCalls.parentPaneKey).not.toHaveBeenCalled()
  })

  it('indexes runtime host labels once per detailed snapshot', () => {
    let environmentIdReads = 0
    const environmentCount = 24
    const runtimeEnvironments = Array.from({ length: environmentCount }, (_, index) => {
      const environment = { id: `environment-${index}`, name: `Builder ${index}` }
      Object.defineProperty(environment, 'id', {
        enumerable: true,
        get: () => {
          environmentIdReads += 1
          return `environment-${index}`
        }
      })
      return environment
    }) as unknown as DashboardSnapshotState['runtimeEnvironments']
    const executionHostId = `runtime:environment-${environmentCount - 1}` as const

    const snapshot = buildDashboardSnapshot(
      baseState({
        repos: [
          {
            id: 'r1',
            path: '/r1',
            displayName: 'Repo One',
            badgeColor: '#000',
            addedAt: 0,
            executionHostId
          }
        ],
        worktreesByRepo: {
          r1: [
            { ...worktree(), hostId: executionHostId },
            { ...worktree('w2', 'wt-two'), hostId: executionHostId }
          ]
        },
        runtimeEnvironments,
        agentStatusByPaneKey: { [PANE_KEY]: entry({}) }
      }),
      NOW
    )

    expect(snapshot.cards[0].hostLabel).toBe(`Builder ${environmentCount - 1}`)
    expect(environmentIdReads).toBe(environmentCount)
  })

  // Singleton/zero dashboard transitions must not release the shared orchestration index still read by mounted sidebar cards.
  it('keeps batch records live and correct when production moves from multi to singleton to zero', () => {
    const secondLeafId = '77777777-7777-4777-8777-777777777777'
    const firstPaneKey = makePaneKey('tab-w1', LEAF_ID)
    const secondPaneKey = makePaneKey('tab-w2', secondLeafId)
    const runtimeAgentOrchestrationByPaneKey = {
      [firstPaneKey]: {
        taskId: 'task-1',
        dispatchId: 'dispatch-1'
      },
      [secondPaneKey]: {
        taskId: 'task-2',
        dispatchId: 'dispatch-2'
      }
    }
    const multiState = baseState({
      worktreesByRepo: { r1: [worktree('w1'), worktree('w2')] },
      tabsByWorktree: {
        w1: [tab('tab-w1', 'w1')],
        w2: [tab('tab-w2', 'w2')]
      },
      runtimeAgentOrchestrationByPaneKey
    })
    const requested = ['w1', 'w2']
    const firstBatch = selectRuntimeAgentOrchestrationBatch(multiState, requested)
    const firstW1 = firstBatch.get('w1')

    buildDashboardSnapshot(
      baseState({
        worktreesByRepo: { r1: [worktree('w1')] },
        tabsByWorktree: multiState.tabsByWorktree,
        runtimeAgentOrchestrationByPaneKey
      }),
      NOW
    )
    const afterSingleton = selectRuntimeAgentOrchestrationBatch(multiState, requested)
    expect(afterSingleton).toBe(firstBatch)
    expect(afterSingleton.get('w1')).toBe(firstW1)

    buildDashboardSnapshot(baseState({ repos: [], worktreesByRepo: {} }), NOW)
    const afterZero = selectRuntimeAgentOrchestrationBatch(multiState, requested)
    expect(afterZero).toBe(firstBatch)
    for (const worktreeId of requested) {
      expect(afterZero.get(worktreeId)).toBe(
        selectRuntimeAgentOrchestrationForWorktree(multiState, worktreeId)
      )
    }
  })

  it('scans orchestration runtime once for a dashboard snapshot', () => {
    const worktreeCount = 24
    const contextCount = 128
    let runtimeEnumerations = 0
    let contextVisits = 0
    const runtimeRecords: Record<string, AgentStatusOrchestrationContext> = {}

    for (let index = 0; index < contextCount; index += 1) {
      const paneKey = makePaneKey(
        `tab-${index % worktreeCount}`,
        `33333333-3333-4333-8333-${index.toString(16).padStart(12, '0')}`
      )
      runtimeRecords[paneKey] = {
        taskId: `task-${index}`,
        dispatchId: `dispatch-${index}`,
        get parentPaneKey() {
          contextVisits += 1
          return undefined
        }
      }
    }

    const runtimeAgentOrchestrationByPaneKey = new Proxy(runtimeRecords, {
      ownKeys(target) {
        runtimeEnumerations += 1
        return Reflect.ownKeys(target)
      }
    })
    const worktrees = Array.from({ length: worktreeCount }, (_, index) =>
      worktree(`w${index}`, `wt-${index}`)
    )
    const tabsByWorktree = Object.fromEntries(
      worktrees.map((worktree, index) => [worktree.id, [tab(`tab-${index}`, worktree.id)]])
    )

    const snapshot = buildDashboardSnapshot(
      baseState({
        worktreesByRepo: { r1: worktrees },
        tabsByWorktree,
        runtimeAgentOrchestrationByPaneKey
      }),
      NOW
    )

    expect(snapshot.cards).toEqual([])
    expect(runtimeEnumerations).toBe(1)
    expect(contextVisits).toBe(contextCount)
  })
})
