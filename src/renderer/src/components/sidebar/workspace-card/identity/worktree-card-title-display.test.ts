import { describe, expect, it } from 'vitest'
import { getWorktreeCardTitleDisplay } from './worktree-card-title-display'

describe('getWorktreeCardTitleDisplay', () => {
  it('keeps a user-set name that matches the branch over a linked task title', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'release/rc-11',
        displayNameMode: 'fixed',
        branchName: 'release/rc-11',
        jiraIssueTitle: 'Refactor billing export'
      })
    ).toBe('release/rc-11')
  })
})
