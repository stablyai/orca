import { describe, expect, it, vi } from 'vitest'
import { buildDashboardSnapshot, type DashboardSnapshotState } from './build-dashboard-snapshot'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusOrchestrationContext
} from '../../../../shared/agent-status-types'
import { DASHBOARD_MAX_LABEL_LENGTH } from '../../../../shared/dashboard-snapshot'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { selectRuntimeAgentOrchestrationBatch } from '../sidebar/worktree-agent-orchestration-batch'
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
const CHILD_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const GRANDCHILD_LEAF_ID = '44444444-4444-4444-8444-444444444444'
const GONE_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const SPLIT_SIBLING_LEAF_ID = '55555555-5555-4555-8555-555555555555'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const CHILD_PANE_KEY = makePaneKey(TAB_ID, CHILD_LEAF_ID)
const GRANDCHILD_PANE_KEY = makePaneKey(TAB_ID, GRANDCHILD_LEAF_ID)

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
    repos: [{ id: 'r1', path: '/r1', displayName: 'Repo One', badgeColor: '#000' }],
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
        ptyIdsByLeafId: { [LEAF_ID]: 'pty1' }
      }
    },
    ptyIdsByTabId: { [TAB_ID]: ['pty1'] },
    runtimePaneTitlesByTabId: {},
    acknowledgedAgentsByPaneKey: {},
    ...overrides
  } as unknown as DashboardSnapshotState
}

describe('buildDashboardSnapshot', () => {
  it('publishes project and workspace-status filters without agent cards', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        repos: [
          { id: 'r1', path: '/r1', displayName: 'Repo One', badgeColor: '#000' },
          { id: 'r2', path: '/r2', displayName: 'Repo Two', badgeColor: '#000' }
        ],
        worktreesByRepo: {
          r1: [worktree()],
          r2: [worktree('w2', 'wt-two')]
        },
        workspaceStatuses: [
          { id: 'planned', label: 'Planned', color: 'neutral' },
          { id: 'active', label: 'Active', color: 'blue' }
        ]
      } as unknown as Partial<DashboardSnapshotState>),
      NOW
    )

    expect(snapshot.cards).toEqual([])
    expect(snapshot.workspaces).toEqual([
      expect.objectContaining({
        repoId: 'r1',
        worktreeId: 'w1',
        repoName: 'Repo One',
        worktreeName: 'wt-one',
        hostKind: 'local',
        executionHostId: 'local',
        workspaceKind: 'worktree'
      }),
      expect.objectContaining({
        repoId: 'r2',
        worktreeId: 'w2',
        repoName: 'Repo Two',
        worktreeName: 'wt-two'
      })
    ])
    expect(snapshot.filterOptions).toEqual({
      projects: [
        { id: 'r1', label: 'Repo One' },
        { id: 'r2', label: 'Repo Two' }
      ],
      workspaceStatuses: [
        { id: 'planned', label: 'Planned', color: 'neutral' },
        { id: 'active', label: 'Active', color: 'blue' }
      ]
    })
  })

  it('maps a live working agent to the working bucket with a resolved ptyId', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: {
          [PANE_KEY]: entry({ state: 'working', lastAssistantMessage: 'Working on it now' })
        }
      }),
      NOW
    )
    expect(snapshot.cards).toHaveLength(1)
    const card = snapshot.cards[0]
    expect(card.bucket).toBe('working')
    expect(card.dotState).toBe('working')
    expect(card.ptyId).toBe('pty1')
    expect(card.worktreeName).toBe('wt-one')
    expect(card.repoName).toBe('Repo One')
    expect(card.leafId).toBe(LEAF_ID)
    expect(card.lastUserMessage).toBe('do the thing')
    expect(card.lastAgentMessage).toBe('Working on it now')
    // Column ordering key: when the agent entered its current state.
    expect(card.stateChangedAt).toBe(NOW - 5000)
    // No ack yet → unseen, mirroring the sidebar's unvisited signal.
    expect(card.unseen).toBe(true)
  })

  it('publishes terminal-backed orchestrated workers under their direct parent', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: {
          [PANE_KEY]: entry({ paneKey: PANE_KEY }),
          [CHILD_PANE_KEY]: entry({ paneKey: CHILD_PANE_KEY }),
          [GRANDCHILD_PANE_KEY]: entry({ paneKey: GRANDCHILD_PANE_KEY })
        },
        runtimeAgentOrchestrationByPaneKey: {
          [CHILD_PANE_KEY]: {
            taskId: 'worker-task',
            dispatchId: 'worker-dispatch',
            parentPaneKey: PANE_KEY
          },
          [GRANDCHILD_PANE_KEY]: {
            taskId: 'nested-worker-task',
            dispatchId: 'nested-worker-dispatch',
            parentPaneKey: CHILD_PANE_KEY
          }
        },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: { type: 'leaf', leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: {
              [LEAF_ID]: 'pty1',
              [CHILD_LEAF_ID]: 'pty-child',
              [GRANDCHILD_LEAF_ID]: 'pty-grandchild'
            }
          }
        },
        ptyIdsByTabId: { [TAB_ID]: ['pty1', 'pty-child', 'pty-grandchild'] }
      }),
      NOW
    )

    expect(snapshot.cards.map((card) => card.paneKey)).toEqual([
      PANE_KEY,
      CHILD_PANE_KEY,
      GRANDCHILD_PANE_KEY
    ])
    expect(snapshot.cards[1]).toMatchObject({
      paneKey: CHILD_PANE_KEY,
      parentPaneKey: PANE_KEY,
      ptyId: 'pty-child'
    })
    expect(snapshot.cards[2]).toMatchObject({
      paneKey: GRANDCHILD_PANE_KEY,
      parentPaneKey: CHILD_PANE_KEY,
      ptyId: 'pty-grandchild'
    })
  })

  it('preserves explicit lineage when a child runs in another worktree', () => {
    const childTabId = 'child-tab'
    const childPaneKey = makePaneKey(childTabId, CHILD_LEAF_ID)
    const snapshot = buildDashboardSnapshot(
      baseState({
        worktreesByRepo: { r1: [worktree(), worktree('w2', 'wt-two')] },
        tabsByWorktree: { w1: [tab()], w2: [tab(childTabId, 'w2')] },
        agentStatusByPaneKey: {
          [PANE_KEY]: entry({ paneKey: PANE_KEY }),
          [childPaneKey]: entry({
            paneKey: childPaneKey,
            tabId: childTabId,
            worktreeId: 'w2',
            orchestration: {
              taskId: 'child-task',
              dispatchId: 'child-dispatch',
              parentPaneKey: PANE_KEY
            }
          })
        },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: { type: 'leaf', leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_ID]: 'pty1' }
          },
          [childTabId]: {
            root: { type: 'leaf', leafId: CHILD_LEAF_ID },
            activeLeafId: CHILD_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [CHILD_LEAF_ID]: 'pty-child' }
          }
        },
        ptyIdsByTabId: { [TAB_ID]: ['pty1'], [childTabId]: ['pty-child'] }
      }),
      NOW
    )

    expect(snapshot.cards.find((item) => item.paneKey === childPaneKey)).toMatchObject({
      worktreeName: 'wt-two',
      parentPaneKey: PANE_KEY
    })
  })

  it('does not publish malformed self-parent lineage', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: {
          [PANE_KEY]: entry({
            orchestration: {
              taskId: 'self-task',
              dispatchId: 'self-dispatch',
              parentPaneKey: PANE_KEY
            }
          })
        }
      }),
      NOW
    )

    expect(snapshot.cards[0].parentPaneKey).toBeUndefined()
  })

  it('carries the tab conversation name and drops status-only titles', () => {
    const named = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: { [PANE_KEY]: entry({}) },
        tabsByWorktree: { w1: [{ ...tab(), customTitle: 'Sparse-checkout parser' }] }
      }),
      NOW
    )
    expect(named.cards[0].conversationName).toBe('Sparse-checkout parser')

    // The fixture tab's title is the 'agent' placeholder — not a name.
    const unnamed = buildDashboardSnapshot(
      baseState({ agentStatusByPaneKey: { [PANE_KEY]: entry({}) } }),
      NOW
    )
    expect(unnamed.cards[0].conversationName).toBeUndefined()
  })

  // STA-2811: both panes of a split tab carried the focused pane's title.
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

  // Why: `orca terminal rename --title` is unbounded, and the main-process
  // validator drops any card whose label exceeds the shared bound.
  it('truncates labels to the length the snapshot validator accepts', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: { [PANE_KEY]: entry({}) },
        tabsByWorktree: { w1: [{ ...tab(), customTitle: 'x'.repeat(5_000) }] }
      }),
      NOW
    )

    expect(snapshot.cards[0].conversationName).toHaveLength(DASHBOARD_MAX_LABEL_LENGTH)
  })

  // Why: filterOptions is snapshot-level, so an over-long project label is not
  // recoverable by dropping a card — it invalidates the entire board.
  it('truncates the project filter label the whole snapshot rides on', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        repos: [
          { id: 'r1', path: '/r1', displayName: 'x'.repeat(5_000), badgeColor: '#000', addedAt: 0 }
        ]
      }),
      NOW
    )

    expect(snapshot.filterOptions?.projects[0].label).toHaveLength(DASHBOARD_MAX_LABEL_LENGTH)
  })

  it('withholds generated titles until the setting enables them', () => {
    const tabs = { w1: [{ ...tab(), generatedTitle: 'Fix the flaky pty test' }] }
    const off = buildDashboardSnapshot(
      baseState({ agentStatusByPaneKey: { [PANE_KEY]: entry({}) }, tabsByWorktree: tabs }),
      NOW
    )
    expect(off.cards[0].conversationName).toBeUndefined()

    const on = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: { [PANE_KEY]: entry({}) },
        tabsByWorktree: tabs,
        settings: { tabAutoGenerateTitle: true }
      } as unknown as Partial<DashboardSnapshotState>),
      NOW
    )
    expect(on.cards[0].conversationName).toBe('Fix the flaky pty test')
  })

  it('ships one icon per card-bearing repo, and none for repos without cards', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        repos: [
          {
            id: 'r1',
            path: '/r1',
            displayName: 'Repo One',
            badgeColor: '#000',
            repoIcon: { type: 'lucide', name: 'Rocket' }
          },
          { id: 'r2', path: '/r2', displayName: 'Repo Two', badgeColor: '#000' }
        ],
        worktreesByRepo: { r1: [worktree()], r2: [worktree('w2', 'wt-two')] },
        agentStatusByPaneKey: { [PANE_KEY]: entry({}) }
      } as unknown as Partial<DashboardSnapshotState>),
      NOW
    )
    // r2 has a worktree but no agent card, so its icon never ships.
    expect(snapshot.repoIconsByRepoId).toEqual({ r1: { type: 'lucide', name: 'Rocket' } })
  })

  it('records a null icon for a card-bearing repo that has none', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({ agentStatusByPaneKey: { [PANE_KEY]: entry({}) } }),
      NOW
    )
    expect(snapshot.repoIconsByRepoId).toEqual({ r1: null })
  })

  it('nulls ptyId when the layout entry points at a dead pty', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: { [PANE_KEY]: entry({}) },
        // Layout still remembers pty1 (it survives restarts), but the live
        // set says that pty is gone — e.g. a parked tab after an app restart.
        ptyIdsByTabId: { [TAB_ID]: [] }
      }),
      NOW
    )
    expect(snapshot.cards[0].ptyId).toBeNull()
  })

  it('moves an acknowledged completion to idle while retaining its raw done state', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: { [PANE_KEY]: entry({ state: 'done' }) },
        acknowledgedAgentsByPaneKey: { [PANE_KEY]: NOW - 1000 }
      }),
      NOW
    )
    // ack (NOW-1000) is after stateStartedAt (NOW-5000) → seen.
    expect(snapshot.cards[0].unseen).toBe(false)
    expect(snapshot.cards[0].dotState).toBe('done')
    expect(snapshot.cards[0].bucket).toBe('idle')
  })

  it('does not mark title-derived rows unseen from synthetic timestamps', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: {},
        runtimePaneTitlesByTabId: {
          [TAB_ID]: { 1: '⠋ Claude Code' }
        }
      }),
      NOW
    )

    expect(snapshot.cards).toHaveLength(1)
    expect(snapshot.cards[0].startedAt).toBe(0)
    expect(snapshot.cards[0].unseen).toBe(false)
  })

  it.each(['blocked', 'waiting'] as const)(
    'routes %s agents to the attention bucket with an ask summary',
    (state) => {
      const snapshot = buildDashboardSnapshot(
        baseState({
          agentStatusByPaneKey: {
            [PANE_KEY]: entry({ state, interactivePrompt: 'Approve deploy?' })
          }
        }),
        NOW
      )
      expect(snapshot.cards[0].bucket).toBe('attention')
      expect(snapshot.cards[0].dotState).toBe(state)
      expect(snapshot.cards[0].askSummary).toBe('Approve deploy?')
    }
  )

  it('decays a stale working agent to the idle bucket', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: {
          [PANE_KEY]: entry({
            state: 'working',
            updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1000
          })
        }
      }),
      NOW
    )
    expect(snapshot.cards[0].bucket).toBe('idle')
    expect(snapshot.cards[0].dotState).toBe('idle')
  })

  it('routes retained done agents to the done bucket', () => {
    const donePaneKey = makePaneKey(TAB_ID, GONE_LEAF_ID)
    const snapshot = buildDashboardSnapshot(
      baseState({
        retainedAgentsByPaneKey: {
          [donePaneKey]: {
            entry: entry({ paneKey: donePaneKey, state: 'done' }),
            worktreeId: 'w1',
            tab: tab() as never,
            agentType: 'claude',
            startedAt: NOW - 60_000
          } as never
        }
      }),
      NOW
    )
    const done = snapshot.cards.find((c) => c.dotState === 'done')
    expect(done).toBeDefined()
    expect(done?.bucket).toBe('done')
  })

  it('includes collapsed subagents and workspace status metadata on the parent card', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        workspaceStatuses: [
          { id: 'todo', label: 'Todo', color: 'neutral' },
          { id: 'reviewing', label: 'Reviewing', color: 'emerald' }
        ],
        worktreesByRepo: {
          r1: [
            {
              ...worktree(),
              workspaceStatus: 'reviewing',
              parentWorktreeId: 'parent-worktree'
            } as Worktree & { parentWorktreeId: string }
          ]
        },
        agentStatusByPaneKey: {
          [PANE_KEY]: entry({
            subagents: [
              {
                id: 'child-1',
                state: 'working',
                startedAt: NOW - 1000,
                description: 'Review loop'
              }
            ]
          })
        }
      }),
      NOW
    )

    expect(snapshot.cards).toHaveLength(1)
    expect(snapshot.cards[0]).toMatchObject({
      workspaceStatusId: 'reviewing',
      workspaceStatusLabel: 'Reviewing',
      workspaceStatusColor: 'emerald',
      parentWorktreeId: 'parent-worktree',
      subagents: [{ name: 'Review loop', dotState: 'working' }]
    })
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
    // Why: the card has a live pty, so only the count-path gate keeps the
    // host-input resolution off the sidebar's per-status-tick rebuild.
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

  it("resolves a live pty's host-input profile for card snapshots", () => {
    const snapshot = buildDashboardSnapshot(
      baseState({ agentStatusByPaneKey: { [PANE_KEY]: entry({}) } }),
      NOW
    )

    expect(snapshot.cards[0].terminalInput?.windowsShiftEnterEncoding).toBe('alt-enter')
    expect(snapshot.cards[0].terminalInput?.kittyKeyboardAdvertised).toBe(true)
  })

  it('relays the idle-column setting in the serialized snapshot', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        settings: { experimentalAgentDashboardShowIdle: true } as never
      }),
      NOW
    )

    expect(snapshot.showIdle).toBe(true)
  })

  it('attaches batched runtime orchestration metadata to dashboard rows', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        worktreesByRepo: { r1: [worktree(), worktree('w2')] },
        tabsByWorktree: {
          w1: [tab()],
          w2: [tab('tab2', 'w2')]
        },
        agentStatusByPaneKey: {
          [PANE_KEY]: entry({})
        },
        runtimeAgentOrchestrationByPaneKey: {
          [PANE_KEY]: {
            taskId: 'task-1',
            dispatchId: 'dispatch-1',
            taskTitle: 'Batched orchestration task'
          }
        }
      }),
      NOW
    )

    expect(snapshot.cards).toHaveLength(1)
    expect(snapshot.cards[0].task).toBe('Batched orchestration task')
  })

  it('releases stale batch references when production moves from multi to singleton to zero', () => {
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
    expect(afterSingleton).not.toBe(firstBatch)
    expect(afterSingleton.get('w1')).not.toBe(firstW1)

    buildDashboardSnapshot(baseState({ repos: [], worktreesByRepo: {} }), NOW)
    const afterZero = selectRuntimeAgentOrchestrationBatch(multiState, requested)
    expect(afterZero).not.toBe(afterSingleton)
    expect(afterZero.get('w1')).not.toBe(afterSingleton.get('w1'))
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
