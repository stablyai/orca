import { describe, expect, it } from 'vitest'
import {
  WORKTREE_MERGE_REVIEW_STASH_MARKER,
  findConflictMarkerPaths,
  findWorktreeMergeReviewStashRef,
  parseUnstagedWorktreePaths,
  parseWorktreeMergeReviewBranch,
  worktreeMergeReviewSnapshotMessage
} from './git-merge-review'

/** `git status --porcelain -z --untracked-files=no` output. */
const status = (...records: string[]): string => records.map((record) => `${record}\0`).join('')

describe('parseUnstagedWorktreePaths', () => {
  // Why: staged merge content is the review itself; listing it would make every
  // clean reject look destructive.
  it('ignores staged-only changes', () => {
    expect(parseUnstagedWorktreePaths(status('M  staged.txt'))).toEqual([])
  })

  it('reports worktree-side edits and conflicts', () => {
    expect(
      parseUnstagedWorktreePaths(status(' M unstaged.txt', 'MM both.txt', 'UU conflicted.txt'))
    ).toEqual(['unstaged.txt', 'both.txt', 'conflicted.txt'])
  })

  // Why: a rename record carries the source path in the next field, which has no
  // status prefix — reading it as a record would invent a phantom edit.
  it('consumes the source path of a rename record', () => {
    expect(parseUnstagedWorktreePaths(status('R  renamed.txt', 'old-name.txt'))).toEqual([])
  })

  it('reads nothing from empty output', () => {
    expect(parseUnstagedWorktreePaths('')).toEqual([])
  })
})

describe('findWorktreeMergeReviewStashRef', () => {
  it('finds the newest stash carrying the marker', () => {
    const listing = [
      'stash@{0}\0WIP on main: 1234 other work',
      `stash@{1}\0On main: ${WORKTREE_MERGE_REVIEW_STASH_MARKER}: auto-stash before syncing feature`
    ].join('\n')
    expect(findWorktreeMergeReviewStashRef(listing)).toBe('stash@{1}')
  })

  it('ignores stashes without the marker', () => {
    expect(findWorktreeMergeReviewStashRef('stash@{0}\0WIP on main: 1234 other work')).toBeNull()
    expect(findWorktreeMergeReviewStashRef('')).toBeNull()
  })
})

describe('parseWorktreeMergeReviewBranch', () => {
  it('reads the branch from the merge message', () => {
    expect(parseWorktreeMergeReviewBranch("Merge branch 'feature/x'\n\nbody\n")).toBe('feature/x')
    expect(parseWorktreeMergeReviewBranch("Merge remote-tracking branch 'origin/main'")).toBe(
      'origin/main'
    )
  })

  it('returns null for a message it cannot attribute', () => {
    expect(parseWorktreeMergeReviewBranch('')).toBeNull()
    expect(parseWorktreeMergeReviewBranch('Some other message')).toBeNull()
  })
})

describe('findConflictMarkerPaths', () => {
  it('reports files whose added lines still carry markers', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '+<<<<<<< HEAD',
      '+ours',
      'diff --git a/b.txt b/b.txt',
      '+++ b/b.txt',
      '+>>>>>>> feature',
      '+======='
    ].join('\n')
    expect(findConflictMarkerPaths(diff)).toEqual(['a.txt', 'b.txt'])
  })

  it('ignores marker-like text that is not an added line', () => {
    expect(findConflictMarkerPaths('+++ b/a.txt\n <<<<<<< HEAD\n')).toEqual([])
  })
})

describe('worktreeMergeReviewSnapshotMessage', () => {
  // Why: the snapshot commit stays in history forever, so it must never be
  // mistaken for — or cleaned up as — a parked stash.
  it('never carries the stash marker', () => {
    const message = worktreeMergeReviewSnapshotMessage('feature')
    expect(message).toBe('wf: feature uncommitted changes snapshot')
    expect(message).not.toContain(WORKTREE_MERGE_REVIEW_STASH_MARKER)
  })
})
