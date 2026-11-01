import { describe, expect, it } from 'vitest'
import { planCommitMessageGeneration } from './commit-message-plan'
import { openCodeVariantRetryPlan } from './opencode-generation-command'

const rejection = 'Unrecognized flag: --variant in command opencode run'
describe('OpenCode generation commands', () => {
  it.each(['opencode', 'opencode.exe', 'opencode.cmd', 'opencode2'])(
    'keeps run before launch flags for %s',
    (binary) => {
      const result = planCommitMessageGeneration(
        { agentId: 'opencode', model: 'default', agentCommandOverride: `${binary} --auto` },
        'PROMPT'
      )
      expect(result).toMatchObject({
        ok: true,
        plan: {
          args: ['run', '--auto', '--agent', 'build', '--format', 'json'],
          stdinPayload: 'PROMPT',
          outputFormat: 'opencode-json'
        }
      })
    }
  )

  it('keeps explicit formatted output recipes on their requested output format', () => {
    const result = planCommitMessageGeneration(
      { agentId: 'opencode', model: 'default', agentArgs: '--format default' },
      'PROMPT'
    )
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.plan.outputFormat).toBeUndefined()
  })

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
  it.each([
    '--model=fixture/chat --variant=high',
    '-mfixture/chat --variant=high',
    '--variant high --model=fixture/chat',
    '--variant=high -m fixture/chat'
  ])('retries the chosen recipe model and variant in %s', (agentArgs) => {
    const result = planCommitMessageGeneration(
      { agentId: 'opencode', model: 'other/model', thinkingLevel: 'low', agentArgs },
      'PROMPT'
    )
    if (!result.ok) {
      throw new Error(result.error)
    }
    const retry = openCodeVariantRetryPlan(result.plan, rejection)
    expect(retry?.args.join(' ')).toContain('fixture/chat#high')
    expect(retry?.args.join(' ')).not.toContain('--variant')
    expect(retry?.stdinPayload).toBe('PROMPT')
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
