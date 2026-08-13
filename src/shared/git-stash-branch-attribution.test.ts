import { describe, expect, it } from 'vitest'
import {
  branchFromStashSubject,
  countStashSubjectsForBranch,
  formatWorktreeStashRemovalDetail,
  formatWorktreeStashVerificationDetail,
  parseStashListSubjects,
  stashSubjectMatchesBranch,
  WORKTREE_STASH_REMOVAL_DETAIL_PREFIX,
  WORKTREE_STASH_REMOVAL_ERROR,
  WORKTREE_STASH_VERIFICATION_ERROR
} from './git-stash-branch-attribution'

describe('git-stash-branch-attribution', () => {
  it('parses On and WIP-on subjects and rejects detached / free-form lines', () => {
    expect(branchFromStashSubject('On agent-a: agent-a WIP')).toBe('agent-a')
    expect(branchFromStashSubject('WIP on agent-b: 84050c1 init')).toBe('agent-b')
    expect(branchFromStashSubject('On feat/nested: named')).toBe('feat/nested')
    expect(branchFromStashSubject('On (no branch): detached')).toBeNull()
    expect(branchFromStashSubject('manual free form')).toBeNull()
    expect(branchFromStashSubject('')).toBeNull()
  })

  it('matches only the recorded branch and ignores index position', () => {
    expect(stashSubjectMatchesBranch('On agent-a: WIP', 'agent-a')).toBe(true)
    expect(stashSubjectMatchesBranch('On agent-a: WIP', 'agent-b')).toBe(false)
    expect(stashSubjectMatchesBranch('WIP on agent-a: x', 'agent-a')).toBe(true)
    expect(stashSubjectMatchesBranch('On (no branch): x', 'agent-a')).toBe(false)
  })

  it('counts branch-attributed subjects and tolerates CRLF list output', () => {
    const subjects = parseStashListSubjects(
      'On agent-a: first\r\nWIP on agent-b: second\nOn agent-a: third\n'
    )
    expect(subjects).toEqual(['On agent-a: first', 'WIP on agent-b: second', 'On agent-a: third'])
    expect(countStashSubjectsForBranch(subjects, 'agent-a')).toBe(2)
    expect(countStashSubjectsForBranch(subjects, 'agent-b')).toBe(1)
    expect(countStashSubjectsForBranch(subjects, 'agent-c')).toBe(0)
    expect(countStashSubjectsForBranch(subjects, '')).toBe(0)
  })

  it('formats stash and verification details without claiming worktree ownership', () => {
    expect(WORKTREE_STASH_REMOVAL_ERROR).not.toContain('uncommitted or untracked')
    const detail = formatWorktreeStashRemovalDetail(2, 'agent-a')
    expect(detail.startsWith(WORKTREE_STASH_REMOVAL_DETAIL_PREFIX)).toBe(true)
    expect(detail).toContain('2 entries')
    expect(detail).toContain('branch agent-a')
    expect(detail).toContain('attribution only')
    expect(detail).toContain('may come from another worktree')
    expect(detail).toContain('force-delete to leave the shared stack unchanged')
    expect(detail.toLowerCase()).not.toContain('ownership')
    expect(formatWorktreeStashRemovalDetail(1, 'feat')).toContain('1 entry')

    const verification = formatWorktreeStashVerificationDetail('agent-a')
    expect(verification).toContain(WORKTREE_STASH_VERIFICATION_ERROR)
    expect(verification).toContain('Branch agent-a')
    expect(verification).toContain('force-delete')
  })
})
