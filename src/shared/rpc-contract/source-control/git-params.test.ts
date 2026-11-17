import { describe, expect, it } from 'vitest'
import { GitGenerateCommitMessage } from './git-params'

describe('GitGenerateCommitMessage', () => {
  it('reads a blank default agent from older clients as null', () => {
    const parsed = GitGenerateCommitMessage.parse({ worktree: 'id:wt-1', defaultTuiAgent: 'blank' })

    expect(parsed.defaultTuiAgent).toBeNull()
  })

  it('still names the cause when the host does not know the default agent', () => {
    const parsed = GitGenerateCommitMessage.safeParse({
      worktree: 'id:wt-1',
      defaultTuiAgent: 'future-agent'
    })

    expect(parsed.error?.issues[0]?.message).toBe('Unknown TUI agent')
  })
})
