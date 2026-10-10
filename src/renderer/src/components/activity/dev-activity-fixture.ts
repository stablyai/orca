import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'

const FIXTURE_REPO_ID = 'dev-fixture-repo'
const FIXTURE_WORKTREE_ID = `${FIXTURE_REPO_ID}::/dev/orca-sample`
const FIXTURE_LEAF_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333'
] as const

function fixtureRepo(): Repo {
  return {
    id: FIXTURE_REPO_ID,
    path: '/dev/orca-sample',
    displayName: 'Orca Sample App',
    badgeColor: '#8b5cf6',
    addedAt: Date.now(),
    kind: 'git',
    executionHostId: 'local'
  }
}

function fixtureWorktree(): Worktree {
  return {
    id: FIXTURE_WORKTREE_ID,
    repoId: FIXTURE_REPO_ID,
    path: '/dev/orca-sample',
    head: 'dev-fixture-head',
    branch: 'feature/activity-dashboard',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Activity dashboard',
    comment: 'Development fixture workspace',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: true,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: Date.now()
  }
}

function fixtureTab(id: string, title: string, sortOrder: number): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: FIXTURE_WORKTREE_ID,
    title,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: Date.now(),
    launchAgent: id === 'dev-fixture-tab-1' ? 'codex' : 'claude'
  }
}

/** Populate a fresh development profile with representative activity rows. */
export function seedDevActivityFixture(): void {
  const state = useAppStore.getState()
  if (state.repos.length > 0 || Object.keys(state.agentStatusByPaneKey).length > 0) {
    return
  }

  const now = Date.now()
  const repo = fixtureRepo()
  const worktree = fixtureWorktree()
  const tabs = [
    fixtureTab('dev-fixture-tab-1', 'Refactor activity filters', 0),
    fixtureTab('dev-fixture-tab-2', 'Review empty-state copy', 1),
    fixtureTab('dev-fixture-tab-3', 'Add keyboard shortcut', 2)
  ]

  useAppStore.setState({
    repos: [repo],
    activeRepoId: repo.id,
    worktreesByRepo: { [repo.id]: [worktree] },
    activeWorktreeId: worktree.id,
    activeWorkspaceKey: `worktree:${worktree.id}`,
    tabsByWorktree: { [worktree.id]: tabs }
  })

  state.setAgentStatuses([
    {
      paneKey: makePaneKey(tabs[0].id, FIXTURE_LEAF_IDS[0]),
      payload: {
        state: 'working',
        prompt: 'Refactor the activity filters and keep the list responsive.',
        agentType: 'codex',
        model: 'gpt-5-codex',
        toolName: 'Edit',
        toolInput: 'activity-scope-filter.ts'
      },
      timing: { updatedAt: now - 12_000, stateStartedAt: now - 90_000 },
      routing: { tabId: tabs[0].id, worktreeId: worktree.id, connectionId: null }
    },
    {
      paneKey: makePaneKey(tabs[1].id, FIXTURE_LEAF_IDS[1]),
      payload: {
        state: 'waiting',
        prompt: 'Review the new empty-state copy before merging.',
        agentType: 'claude',
        model: 'claude-sonnet-4',
        lastAssistantMessage: 'The copy is ready for your review.'
      },
      timing: { updatedAt: now - 45_000, stateStartedAt: now - 120_000 },
      routing: { tabId: tabs[1].id, worktreeId: worktree.id, connectionId: null }
    },
    {
      paneKey: makePaneKey(tabs[2].id, FIXTURE_LEAF_IDS[2]),
      payload: {
        state: 'done',
        prompt: 'Add a shortcut to focus the activity search field.',
        agentType: 'codex',
        model: 'gpt-5-codex',
        lastAssistantMessage: 'Added the shortcut and covered it with a test.'
      },
      timing: { updatedAt: now - 5 * 60_000, stateStartedAt: now - 8 * 60_000 },
      routing: { tabId: tabs[2].id, worktreeId: worktree.id, connectionId: null }
    }
  ])
}
