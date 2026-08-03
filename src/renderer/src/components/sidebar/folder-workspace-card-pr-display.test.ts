import { describe, expect, it } from 'vitest'
import type {
  CheckStatus,
  PRInfo,
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

class LookupOnlyRepoMap extends Map<string, Repo> {
  override values(): MapIterator<Repo> {
    throw new Error('Folder card PR display should use repo lookup instead of repo enumeration')
  }
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
  it('uses the existing repo lookup without enumerating all repos', () => {
    const worktree = makeWorktree({ id: 'lookup-only', linkedPR: 8 })

    const display = getFolderWorkspaceCardPrDisplay({
      folderWorkspaceId: 'folder-1',
      workspaceLineageByChildKey: { [worktree.id]: makeWorkspaceLineage(worktree) },
      worktreeLineageById: {},
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new LookupOnlyRepoMap([[repo.id, repo]]),
      hostedReviewCache: null,
      prCache: {
        'repo-1::lookup-only': makePrEntry(8, 'success')
      }
    })

    expect(display).toMatchObject({ number: 8, status: 'success' })
  })

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
        'repo-1::passing': makePrEntry(1, 'success'),
        'repo-1::pending': makePrEntry(2, 'pending'),
        'repo-1::failing': makePrEntry(3, 'failure')
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
        'repo-1::passing': makePrEntry(1, 'success'),
        'repo-1::pending': makePrEntry(2, 'pending')
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
        'repo-1::nested': makePrEntry(4, 'success')
      }
    })

    expect(display).toMatchObject({ number: 4, status: 'success' })
  })

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

  it.each([
    ['repository', { repoId: 'repo-2' }, {}],
    ['known host', { hostId: 'ssh:remote' as const }, { hostId: 'local' as const }],
    ['known project', { projectId: 'project-b' }, { projectId: 'project-a' }]
  ])('excludes nested PRs across a %s boundary', (_boundary, childOverrides, parentOverrides) => {
    const parent = makeWorktree({ id: 'parent', instanceId: 'parent', ...parentOverrides })
    const nested = makeWorktree({
      id: 'nested',
      instanceId: 'nested',
      linkedPR: 4,
      ...childOverrides
    })
    const nestedRepo = { ...repo, id: nested.repoId }

    const display = getFolderWorkspaceCardPrDisplay({
      folderWorkspaceId: 'folder-1',
      workspaceLineageByChildKey: { [parent.id]: makeWorkspaceLineage(parent) },
      worktreeLineageById: { [nested.id]: makeWorktreeLineage(nested, parent) },
      worktreeMap: new Map([
        [parent.id, parent],
        [nested.id, nested]
      ]),
      repoMap: new Map([
        [repo.id, repo],
        [nestedRepo.id, nestedRepo]
      ]),
      hostedReviewCache: null,
      prCache: { [`${nested.repoId}::nested`]: makePrEntry(4, 'success') }
    })

    expect(display).toBeNull()
  })

  it('excludes nested PRs from cyclic projected lineage', () => {
    const parent = makeWorktree({ id: 'parent', instanceId: 'parent' })
    const nested = makeWorktree({ id: 'nested', instanceId: 'nested', linkedPR: 4 })

    const display = getFolderWorkspaceCardPrDisplay({
      folderWorkspaceId: 'folder-1',
      workspaceLineageByChildKey: { [parent.id]: makeWorkspaceLineage(parent) },
      worktreeLineageById: {
        [parent.id]: makeWorktreeLineage(parent, nested),
        [nested.id]: makeWorktreeLineage(nested, parent)
      },
      worktreeMap: new Map([
        [parent.id, parent],
        [nested.id, nested]
      ]),
      repoMap: new Map([[repo.id, repo]]),
      hostedReviewCache: null,
      prCache: { 'repo-1::nested': makePrEntry(4, 'success') }
    })

    expect(display).toBeNull()
  })

  it('uses branch-discovered PR cache for unlinked attached worktrees', () => {
    const worktree = makeWorktree({ id: 'branch-discovered', linkedPR: null })

    const display = getFolderWorkspaceCardPrDisplay({
      folderWorkspaceId: 'folder-1',
      workspaceLineageByChildKey: { [worktree.id]: makeWorkspaceLineage(worktree) },
      worktreeLineageById: {},
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      hostedReviewCache: null,
      prCache: {
        'repo-1::branch-discovered': { data: makePr(9, 'success'), fetchedAt: 2 }
      }
    })

    expect(display).toMatchObject({ number: 9, status: 'success' })
  })

  it('uses the right-sidebar classified status for conflicting PRs', () => {
    const worktree = makeWorktree({ id: 'conflicting-pr', linkedPR: null })

    const display = getFolderWorkspaceCardPrDisplay({
      folderWorkspaceId: 'folder-1',
      workspaceLineageByChildKey: { [worktree.id]: makeWorkspaceLineage(worktree) },
      worktreeLineageById: {},
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      hostedReviewCache: null,
      prCache: {
        'repo-1::conflicting-pr': {
          data: { ...makePr(11, 'success'), mergeable: 'CONFLICTING' },
          fetchedAt: 2
        }
      }
    })

    expect(display).toMatchObject({ number: 11, status: 'failure' })
  })

  it('does not use stale merged branch PR cache after the worktree advances', () => {
    const worktree = makeWorktree({ id: 'advanced-after-merge', linkedPR: null, head: 'new-head' })

    const display = getFolderWorkspaceCardPrDisplay({
      folderWorkspaceId: 'folder-1',
      workspaceLineageByChildKey: { [worktree.id]: makeWorkspaceLineage(worktree) },
      worktreeLineageById: {},
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      hostedReviewCache: null,
      prCache: {
        'repo-1::advanced-after-merge': {
          data: { ...makePr(10, 'success'), state: 'merged', headSha: 'merged-head' },
          fetchedAt: 2
        }
      }
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
