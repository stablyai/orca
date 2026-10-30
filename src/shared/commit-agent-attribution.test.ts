import { describe, expect, it } from 'vitest'
import { detectCommitAgent } from './commit-agent-attribution'

describe('detectCommitAgent', () => {
  it('reads the agent from a Co-authored-by trailer, as Claude Code writes it', () => {
    expect(
      detectCommitAgent({
        authorEmail: 'dev@example.com',
        message:
          'feat: thing\n\nBody.\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>'
      })
    ).toBe('claude')
  })

  it('reads an agent that authored the commit itself', () => {
    expect(
      detectCommitAgent({
        authorEmail: '198982749+Copilot@users.noreply.github.com',
        message: 'fix'
      })
    ).toBe('copilot')
  })

  it('ignores human co-authors and agent names mentioned in the body', () => {
    expect(
      detectCommitAgent({
        authorEmail: 'dev@example.com',
        message: 'docs: mention noreply@anthropic.com\n\nCo-authored-by: Jane <jane@example.com>'
      })
    ).toBeNull()
  })
})
