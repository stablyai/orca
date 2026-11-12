import { describe, expect, it } from 'vitest'
import { planCommitMessageGeneration } from './source-control/ai/generation/commit-message-plan'
import { openCodeVariantRetryPlan } from './opencode-generation-command'

const rejection = 'Unrecognized flag: --variant in command opencode run'
describe('OpenCode generation commands', () => {
  it('retries only the precise v2 argv rejection, retaining the prompt and selected model', () => {
    const result = planCommitMessageGeneration(
      { agentId: 'opencode', model: 'fixture/chat', thinkingLevel: 'high' },
      'PROMPT'
    )
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(openCodeVariantRetryPlan(result.plan, rejection)).toMatchObject({
      args: ['run', '--model', 'fixture/chat#high', '--agent', 'build', '--format', 'json'],
      stdinPayload: 'PROMPT'
    })
    expect(openCodeVariantRetryPlan(result.plan, 'provider rejected the request')).toBeNull()
    expect(openCodeVariantRetryPlan(result.plan, 'Unrecognized flag: --other')).toBeNull()
  })

  it('does not treat prompt tokens after the terminator as options', () => {
    expect(
      openCodeVariantRetryPlan(
        {
          binary: 'opencode',
          label: 'OpenCode',
          stdinPayload: null,
          args: ['run', '--model=fixture/chat', '--', '--variant=high']
        },
        rejection
      )
    ).toBeNull()
    expect(
      openCodeVariantRetryPlan(
        {
          binary: 'opencode',
          label: 'OpenCode',
          stdinPayload: null,
          args: ['run', '--variant=high', '--', '--model=fixture/chat']
        },
        rejection
      )
    ).toBeNull()
  })
})
