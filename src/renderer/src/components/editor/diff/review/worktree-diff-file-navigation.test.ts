import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { resolveSourceControlGroupOrder } from '../../../../../../shared/source-control/listing/source-control-section-order'
import {
  getAdjacentWorktreeDiffCandidate,
  getWorktreeDiffNavigationCandidates
} from './worktree-diff-file-navigation'

const listOrder = {
  groupOrder: resolveSourceControlGroupOrder(undefined),
  viewMode: 'list'
} as const

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

describe('worktree diff file navigation', () => {
  it('keeps each path once, in Source Control Changes-section order', () => {
    const candidates = getWorktreeDiffNavigationCandidates(
      [
        { path: 'src/10.ts', status: 'modified', area: 'staged' },
        unstaged('src/2.ts'),
        unstaged('src/10.ts'),
        untracked('src/new.ts')
      ],
      listOrder
    )

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      'src/2.ts',
      'src/10.ts',
      'src/new.ts'
    ])
  })

  it('excludes staged-only, pinned-conflict and unresolved-conflict entries', () => {
    const candidates = getWorktreeDiffNavigationCandidates(
      [
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
      ],
      listOrder
    )

    expect(candidates.map((candidate) => candidate.path)).toEqual(['src/eligible.ts'])
  })

  it('sorts untracked entries together with unstaged ones like the Changes section', () => {
    const candidates = getWorktreeDiffNavigationCandidates(
      [untracked('src/r-new.ts'), deleted('src/a-removed.ts')],
      listOrder
    )

    expect(candidates).toEqual([
      expect.objectContaining({ path: 'src/a-removed.ts', status: 'deleted', area: 'unstaged' }),
      expect.objectContaining({ path: 'src/r-new.ts', status: 'untracked', area: 'untracked' })
    ])
  })

  it('keeps staged-only files out regardless of the group order preset', () => {
    const candidates = getWorktreeDiffNavigationCandidates(
      [
        { path: 'src/staged.ts', status: 'modified', area: 'staged' },
        unstaged('src/a.ts'),
        untracked('src/z-new.ts')
      ],
      { groupOrder: resolveSourceControlGroupOrder('staged-first'), viewMode: 'list' }
    )

    expect(candidates.map((candidate) => candidate.path)).toEqual(['src/a.ts', 'src/z-new.ts'])
  })

  it('walks tree view files depth-first, directories first, like the Source Control tree', () => {
    const candidates = getWorktreeDiffNavigationCandidates(
      [untracked('src/z.ts'), unstaged('src/a/deep/x.ts'), unstaged('src/a/b.ts')],
      { groupOrder: resolveSourceControlGroupOrder(undefined), viewMode: 'tree' }
    )

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      'src/a/deep/x.ts',
      'src/a/b.ts',
      'src/z.ts'
    ])
  })

  it.each([
    ['next', 'src/a.ts', 'src/b.ts'],
    ['previous', 'src/a.ts', 'src/c.ts']
  ] as const)('wraps %s from %s to %s', (direction, currentPath, expectedPath) => {
    const candidates = getWorktreeDiffNavigationCandidates(
      [unstaged('src/a.ts'), unstaged('src/b.ts'), unstaged('src/c.ts')],
      listOrder
    )

    expect(getAdjacentWorktreeDiffCandidate({ candidates, currentPath, direction })).toMatchObject({
      path: expectedPath
    })
  })

  it('returns no candidate for a single-file sweep', () => {
    const candidates = getWorktreeDiffNavigationCandidates([unstaged('src/a.ts')], listOrder)

    expect(
      getAdjacentWorktreeDiffCandidate({ candidates, currentPath: 'src/a.ts', direction: 'next' })
    ).toBeNull()
  })

  it('inserts a disappeared path between its neighbors', () => {
    const candidates = getWorktreeDiffNavigationCandidates(
      [unstaged('src/a.ts'), unstaged('src/c.ts'), unstaged('src/d.ts')],
      listOrder
    )

    expect(
      getAdjacentWorktreeDiffCandidate({
        candidates,
        currentPath: 'src/b.ts',
        direction: 'next'
      })
    ).toMatchObject({ path: 'src/c.ts' })
    expect(
      getAdjacentWorktreeDiffCandidate({
        candidates,
        currentPath: 'src/b.ts',
        direction: 'previous'
      })
    ).toMatchObject({ path: 'src/a.ts' })
  })
})
