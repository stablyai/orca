import { describe, expect, it } from 'vitest'

import type { CheckStatus, PRInfo } from '../../../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
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
  it('includes a nested PR from exact inline-only legacy lineage', () => {
    const parent = makeWorktree({ id: 'parent', instanceId: 'parent' })
    const nested = makeWorktree({ id: 'nested', instanceId: 'nested', linkedPR: 4 })
    const inlineNested = { ...nested, lineage: makeWorktreeLineage(nested, parent) } as Worktree

    const display = getFolderWorkspaceCardPrDisplay({
      folderWorkspaceId: 'folder-1',
      workspaceLineageByChildKey: { [parent.id]: makeWorkspaceLineage(parent) },
      worktreeLineageById: {},
      worktreeMap: new Map([
        [parent.id, parent],
        [inlineNested.id, inlineNested]
      ]),
      repoMap: new Map([[repo.id, repo]]),
      hostedReviewCache: null,
      prCache: { 'repo-1::nested': makePrEntry(4, 'success') }
    })

    expect(display).toMatchObject({ number: 4, status: 'success' })
  })

  it('keeps a stale side-map entry authoritative over valid inline lineage', () => {
    const parent = makeWorktree({ id: 'parent', instanceId: 'parent' })
    const nested = makeWorktree({ id: 'nested', instanceId: 'nested', linkedPR: 4 })
    const inlineNested = { ...nested, lineage: makeWorktreeLineage(nested, parent) } as Worktree

    const display = getFolderWorkspaceCardPrDisplay({
      folderWorkspaceId: 'folder-1',
      workspaceLineageByChildKey: { [parent.id]: makeWorkspaceLineage(parent) },
      worktreeLineageById: {
        [nested.id]: {
          ...makeWorktreeLineage(nested, parent),
          parentWorktreeInstanceId: 'stale-parent'
        }
      },
      worktreeMap: new Map([
        [parent.id, parent],
        [inlineNested.id, inlineNested]
      ]),
      repoMap: new Map([[repo.id, repo]]),
      hostedReviewCache: null,
      prCache: { 'repo-1::nested': makePrEntry(4, 'success') }
    })

    expect(display).toBeNull()
  })
})

function makePr(number: number, checksStatus: CheckStatus): PRInfo {
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

function makePrEntry(
  number: number,
  checksStatus: CheckStatus
): { data: PRInfo; fetchedAt: number } {
  return { data: makePr(number, checksStatus), fetchedAt: 2 }
}
