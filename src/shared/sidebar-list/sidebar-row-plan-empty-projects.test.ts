import { expect, it } from 'vitest'
import type { Repo } from '../repo-types'
import type { DetectedWorktree, Worktree } from '../worktree/types'
import { planSidebarRows } from './sidebar-row-plan'

it.each(['imported', 'external'] as const)(
  'hides %s notice-only projects while retaining pinned and pending workspaces',
  (kind) => {
    const repos: Repo[] = ['empty', 'kept', 'creating'].map((id) => ({
      id,
      path: `/${id}`,
      displayName: id,
      badgeColor: '',
      addedAt: 0,
      projectGroupId: `${id}-group`
    }))
    const pinned: Worktree = {
      id: 'workspace',
      repoId: 'kept',
      path: '/kept/workspace',
      head: 'abc',
      branch: 'feature',
      isBare: false,
      isMainWorktree: false,
      displayName: 'Workspace',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: true,
      sortOrder: 0,
      lastActivityAt: 0
    }
    const detected: DetectedWorktree = {
      ...pinned,
      id: 'detected',
      visible: false,
      selectedCheckout: false,
      ownership: 'external'
    }
    const rows = planSidebarRows({
      hideEmptyProjects: true,
      groupBy: 'repo',
      sortBy: 'recent',
      worktrees: [pinned],
      repoMap: new Map(repos.map((repo) => [repo.id, repo])),
      prGroupOf: () => 'in-progress',
      workspaceStatuses: [],
      projectOrderBy: 'manual',
      lineageById: {},
      worktreeMap: new Map([[pinned.id, pinned]]),
      nestLineage: false,
      projectGroups: repos.map((repo) => ({
        id: `${repo.id}-group`,
        name: `${repo.id} group`,
        parentGroupId: null,
        parentPath: '/',
        tabOrder: 0,
        createdAt: 0
      })),
      placeholderRepoIds: new Set(),
      importedWorktreesByRepo:
        kind === 'imported'
          ? new Map(
              repos.map((repo) => [
                repo.id,
                { repo, hiddenWorktrees: [{ ...detected, repoId: repo.id }] }
              ])
            )
          : new Map(),
      newExternalWorktreesInboxByRepo:
        kind === 'external'
          ? new Map(
              repos.map((repo) => [
                repo.id,
                { repo, inboxWorktrees: [{ ...detected, repoId: repo.id }] }
              ])
            )
          : new Map(),
      pendingCreations: [{ creationId: 'new-workspace', repoId: 'creating' }],
      folderWorkspaces: [],
      defaultHostId: 'local',
      pinnedDisplayPolicy: 'single-location',
      filterRepoIds: []
    }).render(new Set())
    expect(
      rows.flatMap((row) => (row.type === 'header' && row.repo ? [row.repo.id] : [])).sort()
    ).toEqual(['creating', 'kept'])
    expect(
      rows.some((row) => row.type === 'header' && row.projectGroup?.id === 'empty-group')
    ).toBe(false)
    expect(rows.some((row) => row.type === 'item' && row.worktree.id === 'workspace')).toBe(true)
    expect(rows.some((row) => row.type === 'pending-creation' && row.repo?.id === 'creating')).toBe(
      true
    )
    expect(
      rows.some(
        (row) =>
          row.type ===
          (kind === 'imported' ? 'imported-worktrees-card' : 'new-external-worktrees-inbox')
      )
    ).toBe(true)
  }
)
