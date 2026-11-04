import { describe, expect, it } from 'vitest'
import type { Repo } from '../repo-types'
import type { DetectedWorktree, Worktree } from '../worktree/types'
import { PINNED_GROUP_KEY } from './group-keys'
import { placeImportedWorktreeLines } from './imported-worktree-lines'
import type { ImportedWorktreesCardCandidate, Row } from './row-types'

const repoA: Repo = {
  id: 'repo-a',
  displayName: 'alpha',
  path: '/a',
  badgeColor: '#000',
  addedAt: 0
}
const repoB: Repo = { ...repoA, id: 'repo-b', displayName: 'beta', path: '/b' }
const remoteA: Repo = { ...repoA, executionHostId: 'runtime:env-1' }

function makeWorktree(id: string, repoId: string): Worktree {
  return {
    id,
    repoId,
    path: `/wt/${id}`,
    branch: `refs/heads/${id}`,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    comment: '',
    isUnread: false,
    isPinned: false,
    displayName: id,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

const hidden: DetectedWorktree[] = [
  {
    ...makeWorktree('hidden', repoA.id),
    visible: false,
    selectedCheckout: false,
    ownership: 'external'
  }
]

function header(key: string): Row {
  return { type: 'header', key, count: 0, icon: { kind: 'all' } }
}

function item(id: string, repo: Repo, sectionKey: string, depth = 0): Row {
  return {
    type: 'item',
    rowKey: id,
    sectionKey,
    worktree: makeWorktree(id, repo.id),
    repo,
    depth,
    groupDepth: 0,
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

function place(
  rows: Row[],
  candidates: Repo[],
  options: { pinned?: Worktree[]; collapsed?: string[] } = {}
): string[] {
  const importedWorktreesByRepo = new Map<string, ImportedWorktreesCardCandidate>(
    candidates.map((repo) => [repo.id, { repo, hiddenWorktrees: hidden }])
  )
  return placeImportedWorktreeLines(rows, {
    importedWorktreesByRepo,
    pinnedSectionWorktrees: options.pinned ?? [],
    collapsedGroups: new Set(options.collapsed ?? []),
    repoOf: () => undefined,
    defaultHostId: 'local'
  }).map((row) =>
    row.type === 'item'
      ? row.worktree.id
      : row.type === 'imported-worktrees-card'
        ? `line:${row.repo.id}`
        : row.type === 'header'
          ? `header:${row.key}`
          : row.type
  )
}

describe('placeImportedWorktreeLines', () => {
  it('keeps lines that share a card in row order when one project is also pinned', () => {
    const rows = [
      header(PINNED_GROUP_KEY),
      item('b-pinned', repoB, PINNED_GROUP_KEY),
      header('in-progress'),
      item('parent', repoA, 'in-progress'),
      item('child', repoB, 'in-progress', 1)
    ]
    expect(place(rows, [repoA, repoB])).toEqual([
      `header:${PINNED_GROUP_KEY}`,
      'b-pinned',
      'header:in-progress',
      'parent',
      'child',
      'line:repo-a',
      'line:repo-b'
    ])
  })

  it('places the line after the whole lineage card, not inside it', () => {
    const rows = [
      header('in-progress'),
      item('parent', repoA, 'in-progress'),
      item('child', repoB, 'in-progress', 1),
      item('other', repoB, 'in-progress')
    ]
    expect(place(rows, [repoA])).toEqual([
      'header:in-progress',
      'parent',
      'child',
      'line:repo-a',
      'other'
    ])
  })

  it('uses Pinned when the natural occurrence is hidden under a collapsed lineage', () => {
    // B's natural row is inside A's collapsed lineage, so only its pinned row rendered.
    const rows = [
      header(PINNED_GROUP_KEY),
      item('b-pinned', repoB, PINNED_GROUP_KEY),
      header('in-progress'),
      item('a-parent', repoA, 'in-progress')
    ]
    expect(place(rows, [repoB])).toEqual([
      `header:${PINNED_GROUP_KEY}`,
      'b-pinned',
      'line:repo-b',
      'header:in-progress',
      'a-parent'
    ])
  })

  it('prefers the first open natural section over Pinned and later sections', () => {
    const rows = [
      header(PINNED_GROUP_KEY),
      item('a-pinned', repoA, PINNED_GROUP_KEY),
      header('in-progress'),
      item('a-1', repoA, 'in-progress'),
      header('in-review'),
      item('a-2', repoA, 'in-review')
    ]
    expect(place(rows, [repoA])).toEqual([
      `header:${PINNED_GROUP_KEY}`,
      'a-pinned',
      'header:in-progress',
      'a-1',
      'line:repo-a',
      'header:in-review',
      'a-2'
    ])
  })

  it('shows a collapsed Pinned project its line after the Pinned header', () => {
    const rows = [
      header(PINNED_GROUP_KEY),
      header('in-progress'),
      item('b-1', repoB, 'in-progress')
    ]
    const pinned = [makeWorktree('a-pinned', repoA.id)]
    expect(place(rows, [repoA], { pinned, collapsed: [PINNED_GROUP_KEY] })).toEqual([
      `header:${PINNED_GROUP_KEY}`,
      'line:repo-a',
      'header:in-progress',
      'b-1'
    ])
  })

  it("anchors only to the candidate's own host registration", () => {
    const rows = [
      header('in-progress'),
      item('a-remote', remoteA, 'in-progress'),
      header('in-review'),
      item('a-local', repoA, 'in-review')
    ]
    expect(place(rows, [repoA])).toEqual([
      'header:in-progress',
      'a-remote',
      'header:in-review',
      'a-local',
      'line:repo-a'
    ])
  })

  it('visits each row a bounded number of times', () => {
    const readsFor = (projects: number): number => {
      const repos = Array.from({ length: projects }, (_, index): Repo => ({
        ...repoA,
        id: `repo-${index}`
      }))
      const rows = [header('all'), ...repos.map((repo) => item(`wt-${repo.id}`, repo, 'all'))]
      let reads = 0
      // Every visit to a row reads its type first, so counting those reads counts the visits.
      for (const row of rows) {
        const type = row.type
        Object.defineProperty(row, 'type', {
          get: () => {
            reads++
            return type
          }
        })
      }
      placeImportedWorktreeLines(rows, {
        importedWorktreesByRepo: new Map(
          repos.map((repo) => [repo.id, { repo, hiddenWorktrees: hidden }])
        ),
        pinnedSectionWorktrees: [],
        collapsedGroups: new Set(),
        repoOf: () => undefined,
        defaultHostId: 'local'
      })
      return reads
    }
    expect(readsFor(1000)).toBeLessThanOrEqual(readsFor(100) * 11)
  })
})
