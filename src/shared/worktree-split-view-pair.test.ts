import { describe, expect, it } from 'vitest'
import { restorableWorktreeSplitViewPair } from './worktree-split-view-pair'

const PAIR = {
  leftWorktreeId: 'wt-a',
  leftExecutionHostId: null,
  rightWorktreeId: 'wt-b',
  rightExecutionHostId: null
}
const VALID = new Set(['wt-a', 'wt-b'])

describe('restorableWorktreeSplitViewPair', () => {
  it('keeps a pair whose sides both exist and that holds the active worktree', () => {
    expect(restorableWorktreeSplitViewPair(PAIR, 'wt-a', VALID)).toBe(PAIR)
    expect(restorableWorktreeSplitViewPair(PAIR, 'wt-b', VALID)).toBe(PAIR)
  })

  it('drops a pair with a missing side', () => {
    expect(restorableWorktreeSplitViewPair(PAIR, 'wt-a', new Set(['wt-a']))).toBeNull()
  })

  it('drops a pair the active worktree is not part of', () => {
    expect(restorableWorktreeSplitViewPair(PAIR, 'wt-c', VALID)).toBeNull()
    expect(restorableWorktreeSplitViewPair(PAIR, null, VALID)).toBeNull()
  })

  it('drops a corrupt pair that names one worktree twice', () => {
    const corrupt = { ...PAIR, rightWorktreeId: 'wt-a' }
    expect(restorableWorktreeSplitViewPair(corrupt, 'wt-a', VALID)).toBeNull()
  })

  it('reads an absent pair as no split', () => {
    expect(restorableWorktreeSplitViewPair(undefined, 'wt-a', VALID)).toBeNull()
  })
})
