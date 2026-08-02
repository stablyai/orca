import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusState
} from '../../../../shared/agent-status-types'
import type { FolderWorkspace, Repo, TerminalTab, Worktree } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { buildRetainedAgentsSyncSnapshot } from './useRetainedAgents'

const ACTIVE_PANE_KEY = makePaneKey('tab-active', '22222222-2222-4222-8222-222222222222')
const ARCHIVED_PANE_KEY = makePaneKey('tab-archived', '33333333-3333-4333-8333-333333333333')
const FOLDER_PANE_KEY = makePaneKey('tab-folder', '44444444-4444-4444-8444-444444444444')
const ARCHIVED_FOLDER_PANE_KEY = makePaneKey(
  'tab-folder-archived',
  '55555555-5555-4555-8555-555555555555'
)

function makeFolderWorkspace(overrides?: Partial<FolderWorkspace>): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Folder',
    folderPath: '/repo/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 1
  }
}

function makeWorktree(overrides?: Partial<Worktree>): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/repo/wt-1',
    head: 'abc123',
    branch: 'feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

function makeTab(overrides?: Partial<TerminalTab>): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function makeEntry(args: {
  paneKey: string
  state: AgentStatusState
  updatedAt: number
  stateStartedAt?: number
  prompt?: string
  toolName?: string
}): AgentStatusEntry {
  return {
    state: args.state,
    prompt: args.prompt ?? 'Fix it',
    updatedAt: args.updatedAt,
    stateStartedAt: args.stateStartedAt ?? args.updatedAt,
    paneKey: args.paneKey,
    terminalTitle: 'Claude',
    stateHistory: [],
    agentType: 'claude',
    toolName: args.toolName
  }
}

describe('buildRetainedAgentsSyncSnapshot', () => {
  it('builds live rows for non-archived worktrees and stale-decays active states', () => {
    const repo = makeRepo()
    const activeWorktree = makeWorktree({ id: 'wt-active' })
    const archivedWorktree = makeWorktree({ id: 'wt-archived', isArchived: true })
    const activeTab = makeTab({ id: 'tab-active', worktreeId: 'wt-active' })
    const archivedTab = makeTab({ id: 'tab-archived', worktreeId: 'wt-archived' })

    const snapshot = buildRetainedAgentsSyncSnapshot({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [activeWorktree, archivedWorktree] },
      folderWorkspaces: [],
      tabsByWorktree: {
        [activeWorktree.id]: [activeTab],
        [archivedWorktree.id]: [archivedTab]
      },
      agentStatusByPaneKey: {
        [ACTIVE_PANE_KEY]: makeEntry({
          paneKey: ACTIVE_PANE_KEY,
          state: 'working',
          updatedAt: 10_000,
          stateStartedAt: 10_000
        }),
        [ARCHIVED_PANE_KEY]: makeEntry({
          paneKey: ARCHIVED_PANE_KEY,
          state: 'done',
          updatedAt: 20_000,
          stateStartedAt: 20_000
        })
      },
      now: 10_000 + AGENT_STATUS_STALE_AFTER_MS + 1
    })

    expect([...snapshot.existingWorktreeIds]).toEqual(['wt-active'])
    expect(snapshot.currentAgents.get(ACTIVE_PANE_KEY)?.row.state).toBe('idle')
    expect(snapshot.currentAgents.get(ARCHIVED_PANE_KEY)).toBeUndefined()
  })

  it('builds live rows for non-archived folder workspaces and skips archived ones', () => {
    const folderWorkspace = makeFolderWorkspace()
    const archivedFolderWorkspace = makeFolderWorkspace({ id: 'folder-2', isArchived: true })
    const workspaceKey = folderWorkspaceKey(folderWorkspace.id)
    const archivedWorkspaceKey = folderWorkspaceKey(archivedFolderWorkspace.id)
    const tab = makeTab({ id: 'tab-folder', worktreeId: workspaceKey })
    const archivedTab = makeTab({ id: 'tab-folder-archived', worktreeId: archivedWorkspaceKey })

    const snapshot = buildRetainedAgentsSyncSnapshot({
      repos: [],
      worktreesByRepo: {},
      folderWorkspaces: [folderWorkspace, archivedFolderWorkspace],
      tabsByWorktree: { [workspaceKey]: [tab], [archivedWorkspaceKey]: [archivedTab] },
      agentStatusByPaneKey: {
        [FOLDER_PANE_KEY]: makeEntry({
          paneKey: FOLDER_PANE_KEY,
          state: 'done',
          updatedAt: 10_000
        }),
        [ARCHIVED_FOLDER_PANE_KEY]: makeEntry({
          paneKey: ARCHIVED_FOLDER_PANE_KEY,
          state: 'done',
          updatedAt: 10_000
        })
      },
      now: 10_000
    })

    expect([...snapshot.existingWorktreeIds]).toEqual([workspaceKey])
    expect(snapshot.currentAgents.get(FOLDER_PANE_KEY)?.worktreeId).toBe(workspaceKey)
    expect(snapshot.currentAgents.get(ARCHIVED_FOLDER_PANE_KEY)).toBeUndefined()
  })
})
