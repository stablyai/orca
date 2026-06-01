import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { ProjectGroup, Repo, TerminalTab, Worktree } from '../../../../shared/types'
import {
  getProjectGroupHeaderKey,
  PINNED_GROUP_KEY,
  type WorktreeGroupBy
} from './worktree-list-groups'
import {
  buildWorktreeSectionActivitySummaries,
  type WorktreeSectionActivityState
} from './worktree-section-activity'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/repo-1',
    displayName: 'repo',
    badgeColor: '#000000',
    addedAt: 0,
    ...overrides
  }
}

function makeProjectGroup(overrides: Partial<ProjectGroup>): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Group',
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/repo-1-feature',
    branch: 'refs/heads/feature',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    comment: '',
    displayName: 'feature',
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeTerminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'zsh',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeState(
  overrides: Partial<WorktreeSectionActivityState> = {}
): WorktreeSectionActivityState {
  return {
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    terminalLayoutRootsByTabId: {},
    agentStatusEpoch: 0,
    agentStatusByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    retainedAgentsByPaneKey: {},
    ...overrides
  }
}

function buildSummaries({
  groupBy = 'repo',
  worktrees,
  repos,
  projectGroups = [],
  state
}: {
  groupBy?: WorktreeGroupBy
  worktrees: readonly Worktree[]
  repos: readonly Repo[]
  projectGroups?: readonly ProjectGroup[]
  state: WorktreeSectionActivityState
}) {
  return buildWorktreeSectionActivitySummaries({
    groupBy,
    worktrees,
    repoMap: new Map(repos.map((repo) => [repo.id, repo])),
    prCache: null,
    workspaceStatuses: [],
    projectGroups,
    state
  })
}

describe('buildWorktreeSectionActivitySummaries', () => {
  it('counts running worktrees across repo project-group ancestors', () => {
    const parent = makeProjectGroup({ id: 'parent', name: 'Parent' })
    const child = makeProjectGroup({
      id: 'child',
      name: 'Child',
      parentGroupId: parent.id
    })
    const repo = makeRepo({ projectGroupId: child.id })
    const worktree = makeWorktree({ repoId: repo.id })
    const state = makeState({
      tabsByWorktree: {
        [worktree.id]: [
          makeTerminalTab({ id: 'tab-1', worktreeId: worktree.id, title: 'Codex working' })
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      }
    })

    const summaries = buildSummaries({
      worktrees: [worktree],
      repos: [repo],
      projectGroups: [parent, child],
      state
    })

    expect(summaries.get(getProjectGroupHeaderKey(parent.id))).toEqual({
      runningCount: 1
    })
    expect(summaries.get(getProjectGroupHeaderKey(child.id))).toEqual({
      runningCount: 1
    })
    expect(summaries.get(`repo:${repo.id}`)).toEqual({
      runningCount: 1
    })
  })

  it('keeps pinned workspace activity on the pinned header only', () => {
    const repo = makeRepo({ projectGroupId: 'group-1' })
    const worktree = makeWorktree({ repoId: repo.id, isPinned: true })
    const now = Date.now()
    const entry: AgentStatusEntry = {
      state: 'working',
      prompt: '',
      updatedAt: now,
      stateStartedAt: now,
      paneKey: 'tab-1:leaf-1',
      stateHistory: []
    }
    const state = makeState({
      tabsByWorktree: {
        [worktree.id]: [makeTerminalTab({ id: 'tab-1', worktreeId: worktree.id })]
      },
      agentStatusEpoch: 1,
      agentStatusByPaneKey: {
        [entry.paneKey]: entry
      }
    })

    const summaries = buildSummaries({
      worktrees: [worktree],
      repos: [repo],
      projectGroups: [makeProjectGroup({ id: 'group-1' })],
      state
    })

    expect(summaries.get(PINNED_GROUP_KEY)).toEqual({
      runningCount: 1
    })
    expect(summaries.get(`repo:${repo.id}`)).toBeUndefined()
    expect(summaries.get(getProjectGroupHeaderKey('group-1'))).toBeUndefined()
  })
})
