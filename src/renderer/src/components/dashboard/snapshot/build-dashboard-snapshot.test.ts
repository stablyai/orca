import { describe, expect, it, vi } from 'vitest'
import {
  buildDashboardSnapshot,
  type DashboardSnapshotInput as DashboardSnapshotState
} from './build-dashboard-snapshot'

import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'

import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../../shared/worktree/types'

import '../../sidebar/workspace-card/activity/worktree-agent-row-selectors'

import type * as DashboardSnapshotWorkspacesModule from './dashboard-snapshot-workspaces'
import type * as AgentRowLineageModule from '../rows/agent-row-lineage'

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

vi.mock('../rows/agent-row-lineage', async (importOriginal) => {
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

  it('labels a waiting agent with its question, not the prompt envelope JSON', () => {
    const interactivePrompt = JSON.stringify({
      questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }] }]
    })
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: {
          [PANE_KEY]: entry({ state: 'waiting', toolName: 'AskUserQuestion', interactivePrompt })
        }
      }),
      NOW
    )
    expect(snapshot.cards[0].askSummary).toBe('Which database?')
  })
})
