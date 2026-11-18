import { describe, expect, it } from 'vitest'
import { GitGenerateCommitMessage } from './git-params'

describe('GitGenerateCommitMessage', () => {
  it('reads a blank default agent from older clients as null', () => {
    const parsed = GitGenerateCommitMessage.parse({ worktree: 'id:wt-1', defaultTuiAgent: 'blank' })

    expect(parsed.defaultTuiAgent).toBeNull()
  })
})
