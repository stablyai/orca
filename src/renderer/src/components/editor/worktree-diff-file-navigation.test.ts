import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import {
  getAdjacentWorktreeDiffCandidate,
  getWorktreeDiffNavigationCandidates
} from './worktree-diff-file-navigation'

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
  it('keeps unstaged/untracked paths once, in Source Control order', () => {
    const candidates = getWorktreeDiffNavigationCandidates([
      { path: 'src/10.ts', status: 'modified', area: 'staged' },
      unstaged('src/2.ts'),
      unstaged('src/10.ts'),
      untracked('src/new.ts')
    ])

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      'src/2.ts',
      'src/10.ts',
      'src/new.ts'
    ])
  })

  it('excludes staged-only and unresolved-conflict entries', () => {
    const candidates = getWorktreeDiffNavigationCandidates([
      { path: 'src/staged.ts', status: 'modified', area: 'staged' },
      { path: 'src/conflict.ts', status: 'modified', area: 'unstaged', conflictStatus: 'unresolved' },
      unstaged('src/eligible.ts')
    ])

    expect(candidates.map((candidate) => candidate.path)).toEqual(['src/eligible.ts'])
  })

  it('retains untracked and deleted unstaged candidates in displayed section order', () => {
    const candidates = getWorktreeDiffNavigationCandidates([
      untracked('src/new.ts'),
      deleted('src/removed.ts')
    ])

    expect(candidates).toEqual([
      expect.objectContaining({ path: 'src/removed.ts', status: 'deleted', area: 'unstaged' }),
      expect.objectContaining({ path: 'src/new.ts', status: 'untracked', area: 'untracked' })
    ])
  })

  it('keeps all Changes entries before untracked entries when Source Control is changes-first', () => {
    const candidates = getWorktreeDiffNavigationCandidates([
      untracked('src/a-new.ts'),
      unstaged('src/z-changed.ts'),
      unstaged('src/b-changed.ts')
    ])

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      'src/b-changed.ts',
      'src/z-changed.ts',
      'src/a-new.ts'
    ])
  })

  it('respects Source Control untracked-first section order', () => {
    const candidates = getWorktreeDiffNavigationCandidates(
      [unstaged('src/a-changed.ts'), untracked('src/z-new.ts'), untracked('src/b-new.ts')],
      ['untracked', 'unstaged', 'staged']
    )

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      'src/b-new.ts',
      'src/z-new.ts',
      'src/a-changed.ts'
    ])
  })

  it.each([
    ['next', 'src/a.ts', 'src/b.ts'],
    ['previous', 'src/a.ts', 'src/c.ts']
  ] as const)('wraps %s from %s to %s', (direction, currentPath, expectedPath) => {
    const candidates = getWorktreeDiffNavigationCandidates([
      unstaged('src/a.ts'),
      unstaged('src/b.ts'),
      unstaged('src/c.ts')
    ])

    expect(getAdjacentWorktreeDiffCandidate({ candidates, currentPath, direction })?.path).toBe(
      expectedPath
    )
  })

  it('returns null when no candidate or no second candidate exists', () => {
    expect(
      getAdjacentWorktreeDiffCandidate({ candidates: [], currentPath: 'src/a.ts', direction: 'next' })
    ).toBeNull()
    expect(
      getAdjacentWorktreeDiffCandidate({
        candidates: getWorktreeDiffNavigationCandidates([unstaged('src/a.ts')]),
        currentPath: 'src/a.ts',
        direction: 'previous'
      })
    ).toBeNull()
  })

  it('selects next relative to the sorted insertion point when current path disappeared', () => {
    const candidates = getWorktreeDiffNavigationCandidates([
      unstaged('src/a.ts'),
      unstaged('src/c.ts'),
      unstaged('src/d.ts')
    ])

    expect(
      getAdjacentWorktreeDiffCandidate({
        candidates,
        currentPath: 'src/b.ts',
        direction: 'next'
      })?.path
    ).toBe('src/c.ts')
  })

  it('selects previous relative to the sorted insertion point when current path disappeared', () => {
    const candidates = getWorktreeDiffNavigationCandidates([
      unstaged('src/a.ts'),
      unstaged('src/c.ts'),
      unstaged('src/d.ts')
    ])

    expect(
      getAdjacentWorktreeDiffCandidate({
        candidates,
        currentPath: 'src/b.ts',
        direction: 'previous'
      })?.path
    ).toBe('src/a.ts')
  })

  it('uses the current area insertion point when a disappeared untracked path was active', () => {
    const candidates = getWorktreeDiffNavigationCandidates(
      [unstaged('src/a.ts'), untracked('src/c.ts'), untracked('src/e.ts')],
      ['untracked', 'unstaged', 'staged']
    )

    expect(
      getAdjacentWorktreeDiffCandidate({
        candidates,
        currentPath: 'src/d.ts',
        currentArea: 'untracked',
        direction: 'next'
      })?.path
    ).toBe('src/e.ts')
  })
})
