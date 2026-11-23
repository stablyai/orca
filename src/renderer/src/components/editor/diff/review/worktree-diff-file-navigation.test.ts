import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { resolveSourceControlGroupOrder } from '../../../../../../shared/source-control/listing/source-control-section-order'
import {
  getAdjacentWorktreeDiffCandidate,
  getWorktreeDiffNavigationCandidates,
  type WorktreeDiffNavigationOrder
} from './worktree-diff-file-navigation'

const order = (
  overrides: Partial<WorktreeDiffNavigationOrder> = {}
): WorktreeDiffNavigationOrder => ({
  groupOrder: resolveSourceControlGroupOrder(undefined),
  viewMode: 'list',
  ...overrides
})

const unstaged = (path: string): GitStatusEntry => ({
  path,
  status: 'modified',
  area: 'unstaged'
})
const untracked = (path: string): GitStatusEntry => ({
  path,
  status: 'untracked',
  area: 'untracked'
})
const deleted = (path: string): GitStatusEntry => ({ path, status: 'deleted', area: 'unstaged' })

const candidatePaths = (entries: GitStatusEntry[], listOrder = order()): string[] =>
  getWorktreeDiffNavigationCandidates(entries, listOrder).map((candidate) => candidate.path)

describe('worktree diff file navigation', () => {
  it('keeps each path once, in Source Control Changes-section order', () => {
    expect(
      candidatePaths([
        { path: 'src/10.ts', status: 'modified', area: 'staged' },
        unstaged('src/2.ts'),
        unstaged('src/10.ts'),
        untracked('src/new.ts')
      ])
    ).toEqual(['src/2.ts', 'src/10.ts', 'src/new.ts'])
  })

  it('excludes staged-only, pinned-conflict and unresolved-conflict entries', () => {
    expect(
      candidatePaths([
        { path: 'src/staged.ts', status: 'modified', area: 'staged' },
        {
          path: 'src/conflict.ts',
          status: 'modified',
          area: 'unstaged',
          conflictStatus: 'unresolved'
        },
        {
          path: 'src/resolved.ts',
          status: 'modified',
          area: 'unstaged',
          conflictStatus: 'resolved_locally'
        },
        unstaged('src/eligible.ts')
      ])
    ).toEqual(['src/eligible.ts'])
  })

  it('sorts untracked entries together with unstaged ones like the Changes section', () => {
    const candidates = getWorktreeDiffNavigationCandidates(
      [untracked('src/r-new.ts'), deleted('src/a-removed.ts')],
      order()
    )

    expect(candidates).toEqual([
      expect.objectContaining({ path: 'src/a-removed.ts', status: 'deleted', area: 'unstaged' }),
      expect.objectContaining({ path: 'src/r-new.ts', status: 'untracked', area: 'untracked' })
    ])
  })

  it('applies the live Source Control filter to the sweep', () => {
    expect(
      candidatePaths([unstaged('src/a.ts'), unstaged('src/b.ts')], order({ filterQuery: 'a.' }))
    ).toEqual(['src/a.ts'])
    expect(
      candidatePaths([unstaged('src/a.ts'), unstaged('src/b.ts')], order({ filterQuery: 'zzz' }))
    ).toEqual([])
  })

  it('walks tree view files depth-first, directories first, like the Source Control tree', () => {
    expect(
      candidatePaths(
        [untracked('src/z.ts'), unstaged('src/a/deep/x.ts'), unstaged('src/a/b.ts')],
        order({ viewMode: 'tree' })
      )
    ).toEqual(['src/a/deep/x.ts', 'src/a/b.ts', 'src/z.ts'])
  })

  it('steps to the interior neighbor in both directions', () => {
    const entries = [unstaged('src/a.ts'), unstaged('src/b.ts'), unstaged('src/c.ts')]

    expect(
      getAdjacentWorktreeDiffCandidate({
        entries,
        order: order(),
        currentPath: 'src/a.ts',
        direction: 'next'
      })
    ).toMatchObject({ path: 'src/b.ts' })
    expect(
      getAdjacentWorktreeDiffCandidate({
        entries,
        order: order(),
        currentPath: 'src/c.ts',
        direction: 'previous'
      })
    ).toMatchObject({ path: 'src/b.ts' })
  })

  it('stops at the list ends instead of wrapping across files', () => {
    const entries = [unstaged('src/a.ts'), unstaged('src/b.ts')]

    expect(
      getAdjacentWorktreeDiffCandidate({
        entries,
        order: order(),
        currentPath: 'src/b.ts',
        direction: 'next'
      })
    ).toBeNull()
    expect(
      getAdjacentWorktreeDiffCandidate({
        entries,
        order: order(),
        currentPath: 'src/a.ts',
        direction: 'previous'
      })
    ).toBeNull()
    expect(
      getAdjacentWorktreeDiffCandidate({
        entries,
        order: order(),
        currentPath: 'src/a.ts',
        direction: 'next'
      })
    ).toMatchObject({ path: 'src/b.ts' })
  })

  it('places a disappeared path between its projected neighbors across mixed areas', () => {
    const entries = [
      unstaged('src/a.ts'),
      untracked('src/b.ts'),
      unstaged('src/d.ts'),
      unstaged('src/f.ts')
    ]

    expect(
      getAdjacentWorktreeDiffCandidate({
        entries,
        order: order(),
        currentPath: 'src/e.ts',
        direction: 'next'
      })
    ).toMatchObject({ path: 'src/f.ts' })
    expect(
      getAdjacentWorktreeDiffCandidate({
        entries,
        order: order(),
        currentPath: 'src/e.ts',
        direction: 'previous'
      })
    ).toMatchObject({ path: 'src/d.ts' })
  })

  it('returns no adjacent candidate for a single-file sweep', () => {
    expect(
      getAdjacentWorktreeDiffCandidate({
        entries: [unstaged('src/a.ts')],
        order: order(),
        currentPath: 'src/a.ts',
        direction: 'next'
      })
    ).toBeNull()
  })
})
