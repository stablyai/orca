import { describe, expect, it } from 'vitest'
import { readCommitDraftForWorktree, writeCommitDraftForWorktree } from './SourceControl'

describe('SourceControl commit drafts by worktree', () => {
  it('returns an empty draft when the selected worktree has no message', () => {
    expect(readCommitDraftForWorktree({}, 'wt-a')).toBe('')
  })

  it('restores each worktree draft when switching between worktrees', () => {
    let drafts = {}

    drafts = writeCommitDraftForWorktree(drafts, 'wt-a', 'feat: message for A')
    expect(readCommitDraftForWorktree(drafts, 'wt-a')).toBe('feat: message for A')

    drafts = writeCommitDraftForWorktree(drafts, 'wt-b', 'fix: message for B')
    expect(readCommitDraftForWorktree(drafts, 'wt-b')).toBe('fix: message for B')

    // Why: switching back must keep the prior draft for that worktree rather
    // than leaking the active worktree's text into all worktree views.
    expect(readCommitDraftForWorktree(drafts, 'wt-a')).toBe('feat: message for A')
  })
})
