import { describe, expect, it } from 'vitest'
import { planCommitMessageGeneration } from './commit-message-plan'

describe('planCommitMessageGeneration', () => {
  it('pipes the Cursor prompt on stdin so Windows batch launchers can start it (#8793)', () => {
    const prompt = 'Write a commit message.\n\ndiff --git a/x b/x'
    const result = planCommitMessageGeneration({ agentId: 'cursor', model: 'auto' }, prompt)

    expect(result).toMatchObject({
      ok: true,
      plan: {
        binary: 'cursor-agent',
        args: ['--print', '--mode', 'ask', '--trust', '--output-format', 'text', '--model', 'auto'],
        stdinPayload: prompt
      }
    })
  })
})
