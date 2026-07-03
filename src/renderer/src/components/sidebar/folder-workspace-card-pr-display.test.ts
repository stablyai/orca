import { describe, expect, it } from 'vitest'
import type {
  CheckStatus,
  Repo,
  Worktree,
  WorktreeLineage,
  WorkspaceLineage
} from '../../../../shared/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { getFolderWorkspaceCardPrDisplay } from './folder-workspace-card-pr-display'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#999999',
  addedAt: 1
}

function makeWorktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  const { id, ...rest } = overrides
  return {
    id,
    repoId: repo.id,
    path: `/worktrees/${id}`,
    displayName: id,
    branch: `refs/heads/${id}`,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...rest
  }
}

function makeWorkspaceLineage(worktree: Worktree): WorkspaceLineage {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
    childInstanceId: worktree.instanceId ?? null,
    parentWorkspaceKey: folderWorkspaceKey('folder-1'),
    parentInstanceId: null,
    origin: 'cli',
    capture: { source: 'env-workspace', confidence: 'inferred' },
    createdAt: 1
  }
}

function makeWorktreeLineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId ?? '',
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId ?? '',
    origin: 'cli',
    capture: { source: 'env-workspace', confidence: 'inferred' },
    createdAt: 1
  }
}

describe('getFolderWorkspaceCardPrDisplay', () => {
  it('uses failing attached PR status ahead of pending and passing PRs', () => {
    const passing = makeWorktree({ id: 'passing', linkedPR: 1 })
    const pending = makeWorktree({ id: 'pending', linkedPR: 2 })
    const failing = makeWorktree({ id: 'failing', linkedPR: 3 })

    const display = getFolderWorkspaceCardPrDisplay({
      folderWorkspaceId: 'folder-1',
      workspaceLineageByChildKey: {
        [passing.id]: makeWorkspaceLineage(passing),
        [pending.id]: makeWorkspaceLineage(pending),
        [failing.id]: makeWorkspaceLineage(failing)
      },
      worktreeLineageById: {},
      worktreeMap: new Map([
        [passing.id, passing],
        [pending.id, pending],
        [failing.id, failing]
      ]),
      repoMap: new Map([[repo.id, repo]]),
      hostedReviewCache: null,
      prCache: {
        'repo-1::passing': { data: makePr(1, 'success') },
        'repo-1::pending': { data: makePr(2, 'pending') },
        'repo-1::failing': { data: makePr(3, 'failure') }
      }
    })

    expect(display).toMatchObject({ number: 3, status: 'failure' })
  })

  it('uses pending attached PR status ahead of passing PRs', () => {
    const passing = makeWorktree({ id: 'passing', linkedPR: 1 })
    const pending = makeWorktree({ id: 'pending', linkedPR: 2 })

    const display = getFolderWorkspaceCardPrDisplay({
      folderWorkspaceId: 'folder-1',
      workspaceLineageByChildKey: {
        [passing.id]: makeWorkspaceLineage(passing),
        [pending.id]: makeWorkspaceLineage(pending)
      },
      worktreeLineageById: {},
      worktreeMap: new Map([
        [passing.id, passing],
        [pending.id, pending]
      ]),
      repoMap: new Map([[repo.id, repo]]),
      hostedReviewCache: null,
      prCache: {
        'repo-1::passing': { data: makePr(1, 'success') },
        'repo-1::pending': { data: makePr(2, 'pending') }
      }
    })

    expect(display).toMatchObject({ number: 2, status: 'pending' })
  })

  it('includes nested attached worktree PRs', () => {
    const parent = makeWorktree({ id: 'parent', instanceId: 'parent' })
    const nested = makeWorktree({ id: 'nested', instanceId: 'nested', linkedPR: 4 })

    const display = getFolderWorkspaceCardPrDisplay({
      folderWorkspaceId: 'folder-1',
      workspaceLineageByChildKey: { [parent.id]: makeWorkspaceLineage(parent) },
      worktreeLineageById: { [nested.id]: makeWorktreeLineage(nested, parent) },
      worktreeMap: new Map([
        [parent.id, parent],
        [nested.id, nested]
      ]),
      repoMap: new Map([[repo.id, repo]]),
      hostedReviewCache: null,
      prCache: {
        'repo-1::nested': { data: makePr(4, 'success') }
      }
    })

    expect(display).toMatchObject({ number: 4, status: 'success' })
  })
})

function makePr(number: number, checksStatus: CheckStatus) {
  return {
    number,
    title: `PR ${number}`,
    state: 'open',
    url: `https://example.test/pull/${number}`,
    checksStatus,
    updatedAt: '2026-01-01T00:00:00.000Z',
    mergeable: 'UNKNOWN'
  }
}
