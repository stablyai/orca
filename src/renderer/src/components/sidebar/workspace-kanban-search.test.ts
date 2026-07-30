import { describe, expect, it } from 'vitest'
import { WORKTREE_PALETTE_QUERY_MAX_BYTES } from '@/lib/worktree-palette-query-bounds'
import type { Repo, Worktree } from '../../../../shared/types'
import {
  buildWorkspaceKanbanLaneViews,
  matchWorkspaceBoardWorktrees
} from './workspace-kanban-search'

function worktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    repoId: 'repo-a',
    displayName: 'Workspace',
    path: `/${overrides.id}`,
    branch: 'main',
    baseBranch: 'main',
    isPinned: false,
    sortOrder: 1,
    ...overrides
  } as Worktree
}

const repoMap = new Map<string, Repo>([
  ['repo-a', { id: 'repo-a', displayName: 'orca' } as Repo],
  ['repo-b', { id: 'repo-b', displayName: 'atlas' } as Repo]
])

function match(worktrees: Worktree[], query: string): ReadonlySet<string> | null {
  return matchWorkspaceBoardWorktrees({ worktrees, query, repoMap })
}

describe('matchWorkspaceBoardWorktrees', () => {
  it('treats blank and whitespace-only queries as no filtering', () => {
    const worktrees = [worktree({ id: 'a' })]
    expect(match(worktrees, '')).toBeNull()
    expect(match(worktrees, '   ')).toBeNull()
  })

  it('matches display name, branch, and repo display name', () => {
    const worktrees = [
      worktree({ id: 'name', displayName: 'Search field' }),
      worktree({ id: 'branch', displayName: 'Other', branch: 'refs/heads/feat/search-lane' }),
      worktree({ id: 'repo', displayName: 'Other', repoId: 'repo-b' }),
      worktree({ id: 'miss', displayName: 'Other' })
    ]

    expect(match(worktrees, 'search')).toEqual(new Set(['name', 'branch']))
    expect(match(worktrees, 'atlas')).toEqual(new Set(['repo']))
  })

  it('matches the workspace comment', () => {
    const worktrees = [
      worktree({ id: 'commented', displayName: 'Other', comment: 'blocked on review' }),
      worktree({ id: 'miss', displayName: 'Other' })
    ]

    expect(match(worktrees, 'blocked')).toEqual(new Set(['commented']))
  })

  it('excludes worktrees that only match on PR, issue, or port', () => {
    const worktrees = [
      worktree({ id: 'pr', displayName: 'Other', linkedPR: 4242 }),
      worktree({ id: 'issue', displayName: 'Other', linkedIssue: 4242 })
    ]

    expect(match(worktrees, '4242')).toEqual(new Set())
  })

  it('matches composite repo/branch queries', () => {
    const worktrees = [
      worktree({ id: 'hit', displayName: 'Other', branch: 'main' }),
      worktree({ id: 'wrong-repo', displayName: 'Other', repoId: 'repo-b', branch: 'main' })
    ]

    expect(match(worktrees, 'orca/main')).toEqual(new Set(['hit']))
  })

  it('is case-insensitive', () => {
    const worktrees = [worktree({ id: 'a', displayName: 'Search Field' })]

    expect(match(worktrees, 'SEARCH')).toEqual(new Set(['a']))
  })

  it('treats regex metacharacters as literal text', () => {
    // Why: matching is indexOf, never RegExp. This pins that, so swapping in a
    // regex later fails here instead of silently changing what users can search.
    const worktrees = [
      worktree({ id: 'literal', displayName: 'feat.*fix' }),
      worktree({ id: 'would-match-as-regex', displayName: 'featANYfix' })
    ]

    expect(match(worktrees, 'feat.*fix')).toEqual(new Set(['literal']))
    expect(match(worktrees, '(')).toEqual(new Set())
  })

  it('matches non-ASCII display names and comments', () => {
    const worktrees = [
      worktree({ id: 'cjk', displayName: '検索フィールド' }),
      worktree({ id: 'accent', displayName: 'Other', comment: 'Añadir búsqueda' }),
      worktree({ id: 'miss', displayName: 'Other' })
    ]

    expect(match(worktrees, 'フィールド')).toEqual(new Set(['cjk']))
    expect(match(worktrees, 'BÚSQUEDA')).toEqual(new Set(['accent']))
  })

  it('treats an over-bound query as no filtering rather than zero matches', () => {
    const worktrees = [worktree({ id: 'a', displayName: 'Search field' })]

    expect(match(worktrees, 'x'.repeat(WORKTREE_PALETTE_QUERY_MAX_BYTES + 1))).toBeNull()
  })
})

describe('buildWorkspaceKanbanLaneViews', () => {
  const todo = [worktree({ id: 'todo-a', displayName: 'Alpha' }), worktree({ id: 'todo-b' })]
  const doing = [worktree({ id: 'doing-a', displayName: 'Alpha' })]
  const worktreesByStatus = new Map([
    ['todo', todo],
    ['doing', doing]
  ])

  it('reuses the input arrays when no query is active', () => {
    const views = buildWorkspaceKanbanLaneViews({ worktreesByStatus, matchingWorktreeIds: null })

    expect(views.get('todo')?.items).toBe(todo)
    expect(views.get('doing')?.items).toBe(doing)
    expect(views.get('todo')?.totalCount).toBe(2)
  })

  it('preserves lane order and per-lane sort order', () => {
    const views = buildWorkspaceKanbanLaneViews({
      worktreesByStatus,
      matchingWorktreeIds: new Set(['todo-b', 'todo-a', 'doing-a'])
    })

    expect(Array.from(views.keys())).toEqual(['todo', 'doing'])
    expect(views.get('todo')?.items.map((item) => item.id)).toEqual(['todo-a', 'todo-b'])
  })

  it('keeps a fully filtered lane with an empty item list and its real total', () => {
    const views = buildWorkspaceKanbanLaneViews({
      worktreesByStatus,
      matchingWorktreeIds: new Set(['doing-a'])
    })

    expect(views.get('todo')).toEqual({ items: [], totalCount: 2 })
    expect(views.get('doing')?.items.map((item) => item.id)).toEqual(['doing-a'])
  })
})
