import type { Repo } from '../../../../shared/repo-types'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'
import type { AppState } from '@/store/types'

// Typed store rows for the workspace-scoped native chat suites.

export function terminalTabFixture(
  id: string,
  worktreeId: string,
  overrides: Partial<TerminalTab> = {}
): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

export function agentSessionTabFixture(
  id: string,
  worktreeId: string,
  overrides: Partial<Tab> = {}
): Tab {
  return {
    id,
    worktreeId,
    groupId: 'group',
    contentType: 'agent-session',
    entityId: `session-${id}`,
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    isPinned: false,
    agentSessionAgent: 'codex',
    ...overrides
  }
}

export function repoFixture(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000000',
    addedAt: 0,
    ...overrides
  }
}

export function worktreeFixture(
  id: string,
  path: string,
  overrides: Partial<Worktree> = {}
): Worktree {
  return {
    id,
    repoId: 'repo',
    path,
    head: 'abc123',
    branch: 'refs/heads/main',
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
    lastActivityAt: 0,
    ...overrides
  }
}

/** A repo listing that holds only detected (not visible) worktrees. */
export function detectedListingFixture(
  worktrees: readonly Worktree[]
): AppState['detectedWorktreesByRepo'][string] {
  const listing: DetectedWorktreeListResult = {
    repoId: worktrees[0]?.repoId ?? 'repo',
    authoritative: true,
    source: 'git',
    worktrees: worktrees.map((worktree) => ({
      ...worktree,
      ownership: 'external',
      selectedCheckout: false,
      visible: false
    }))
  }
  return listing
}
