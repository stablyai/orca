import { describe, expect, it } from 'vitest'
import { resolveLastAgentReply } from './resolve-last-agent-reply'

describe('resolveLastAgentReply', () => {
  it('picks freshest message for the worktree', () => {
    const result = resolveLastAgentReply({
      worktreeId: 'wt-1',
      entries: [
        {
          paneKey: 't1:l1',
          worktreeId: 'wt-1',
          updatedAt: 10,
          lastAssistantMessage: 'older'
        },
        {
          paneKey: 't1:l2',
          worktreeId: 'wt-1',
          updatedAt: 20,
          lastAssistantMessage: 'Looks like a login form sketch.'
        },
        {
          paneKey: 'other:l1',
          worktreeId: 'wt-2',
          updatedAt: 99,
          lastAssistantMessage: 'wrong worktree'
        }
      ]
    })
    expect(result).toEqual({
      body: 'Looks like a login form sketch.',
      paneKey: 't1:l2'
    })
  })

  it('returns null when nothing matches', () => {
    expect(
      resolveLastAgentReply({
        worktreeId: 'wt-x',
        entries: [{ paneKey: 'a', worktreeId: 'wt-y', lastAssistantMessage: 'nope' }]
      })
    ).toBeNull()
  })
})
