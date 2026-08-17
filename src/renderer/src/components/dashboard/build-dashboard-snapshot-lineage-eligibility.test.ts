import { describe, expect, it } from 'vitest'
import { ORCA_DISPATCH_PREAMBLE_PREFIX } from '@/lib/agent-row-primary-text'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { deriveAgentMapLayout } from '../dashboard-popout/agent-map-layout'
import { buildDashboardSnapshot, type DashboardSnapshotState } from './build-dashboard-snapshot'

const NOW = 1_000_000_000
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const CHILD_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const PANE_KEY = makePaneKey('parent-tab', LEAF_ID)
const CHILD_PANE_KEY = makePaneKey('child-tab', CHILD_LEAF_ID)

function dispatchPrompt(taskId: string): string {
  return `${ORCA_DISPATCH_PREAMBLE_PREFIX}\nYour task ID is: ${taskId}\n=== TASK ===\nCurrent task`
}

function worktree(id: string, parentWorktreeId?: string): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: `/repo/${id}`,
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
    lastActivityAt: NOW,
    ...(parentWorktreeId ? { parentWorktreeId } : {})
  } as Worktree
}

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title: 'codex',
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
    tabId,
    worktreeId,
    state: 'working',
    prompt: 'Standalone work',
    updatedAt: NOW,
    stateStartedAt: NOW - 1000,
    stateHistory: [],
    agentType: 'codex',
    ...overrides
  }
}

function state(entries: Record<string, AgentStatusEntry>): DashboardSnapshotState {
  return {
    repos: [{ id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: '#000' }],
    worktreesByRepo: { 'repo-1': [worktree('parent'), worktree('child', 'parent')] },
    tabsByWorktree: {
      parent: [tab('parent-tab', 'parent')],
      child: [tab('child-tab', 'child')]
    },
    agentStatusByPaneKey: entries,
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId: {
      'parent-tab': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-parent-tab' }
      },
      'child-tab': {
        root: { type: 'leaf', leafId: CHILD_LEAF_ID },
        activeLeafId: CHILD_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [CHILD_LEAF_ID]: 'pty-child-tab' }
      }
    },
    ptyIdsByTabId: {
      'parent-tab': ['pty-parent-tab'],
      'child-tab': ['pty-child-tab']
    },
    runtimePaneTitlesByTabId: {},
    acknowledgedAgentsByPaneKey: {}
  } as unknown as DashboardSnapshotState
}

describe('buildDashboardSnapshot pane-lineage eligibility', () => {
  it('publishes active lineage when a status ping omits its cached prompt', () => {
    const snapshot = buildDashboardSnapshot(
      state({
        [CHILD_PANE_KEY]: entry(CHILD_PANE_KEY, 'child-tab', 'child', {
          prompt: '',
          orchestration: {
            taskId: 'active-task',
            dispatchId: 'active-dispatch',
            dispatchStatus: 'dispatched',
            parentPaneKey: PANE_KEY
          }
        })
      }),
      NOW
    )

    expect(snapshot.cards.find((card) => card.paneKey === CHILD_PANE_KEY)?.parentPaneKey).toBe(
      PANE_KEY
    )
  })

  it('publishes eligible lineage resolved through the parent terminal handle', () => {
    const dashboardState = state({
      [PANE_KEY]: entry(PANE_KEY, 'parent-tab', 'parent', {
        terminalHandle: 'term-parent'
      }),
      [CHILD_PANE_KEY]: entry(CHILD_PANE_KEY, 'child-tab', 'parent', {
        prompt: dispatchPrompt('active-task'),
        orchestration: {
          taskId: 'active-task',
          dispatchId: 'active-dispatch',
          dispatchStatus: 'dispatched',
          parentTerminalHandle: 'term-parent'
        }
      })
    })
    dashboardState.tabsByWorktree = {
      parent: [tab('parent-tab', 'parent'), tab('child-tab', 'parent')],
      child: []
    }
    const snapshot = buildDashboardSnapshot(dashboardState, NOW)

    expect(snapshot.cards.find((card) => card.paneKey === CHILD_PANE_KEY)?.parentPaneKey).toBe(
      PANE_KEY
    )
  })

  it('omits recently settled lineage merged into a matching live row', () => {
    const dashboardState = state({
      [CHILD_PANE_KEY]: entry(CHILD_PANE_KEY, 'child-tab', 'child', {
        prompt: dispatchPrompt('settled-task'),
        orchestration: {
          taskId: 'settled-task',
          dispatchId: 'settled-dispatch',
          parentPaneKey: PANE_KEY
        }
      })
    })
    dashboardState.runtimeAgentOrchestrationByPaneKey = {
      [CHILD_PANE_KEY]: {
        taskId: 'settled-task',
        dispatchId: 'settled-dispatch',
        dispatchStatus: 'completed',
        parentPaneKey: PANE_KEY
      }
    }

    expect(
      buildDashboardSnapshot(dashboardState, NOW).cards.find(
        (card) => card.paneKey === CHILD_PANE_KEY
      )?.parentPaneKey
    ).toBeUndefined()
  })

  it('keeps workspace packing after stale pane lineage is omitted', () => {
    const snapshot = buildDashboardSnapshot(
      state({
        [PANE_KEY]: entry(PANE_KEY, 'parent-tab', 'parent'),
        [CHILD_PANE_KEY]: entry(CHILD_PANE_KEY, 'child-tab', 'child', {
          orchestration: {
            taskId: 'settled-task',
            dispatchId: 'settled-dispatch',
            dispatchStatus: 'completed',
            parentPaneKey: PANE_KEY
          }
        })
      }),
      NOW
    )

    const childCard = snapshot.cards.find((card) => card.worktreeId === 'child')!
    expect(childCard.parentPaneKey).toBeUndefined()
    expect(childCard.parentWorktreeId).toBe('parent')
    const project = deriveAgentMapLayout(snapshot.cards, 400).projects[0]
    const parent = project.worktrees.find((item) => item.worktreeId === 'parent')!
    const child = project.worktrees.find((item) => item.worktreeId === 'child')!
    expect(child.parentId).toBe(parent.id)
  })
})
