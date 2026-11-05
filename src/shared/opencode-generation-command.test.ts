import { describe, expect, it } from 'vitest'
import { planCommitMessageGeneration } from './source-control/ai/generation/commit-message-plan'
import {
  openCodeVariantRetryPlan,
  withOpenCodeTextGenerationPolicy
} from './opencode-generation-command'

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
          args: ['run', '--auto', '--standalone', '--agent', 'build', '--format', 'json'],
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
      args: [
        'run',
        '--standalone',
        '--model',
        'fixture/chat#high',
        '--agent',
        'build',
        '--format',
        'json'
      ],
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

describe('OpenCode text-generation tool policy', () => {
  const permission = { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' }
  const policy = { permission, agent: { build: { permission } } }

  it.each([
    ['replaces permissions', '{"model":"x/y","permission":{"*":"allow"}}', { model: 'x/y' }],
    ['reads JSONC', '{ // note\n"model":"x/y",}', { model: 'x/y' }],
    ['replaces malformed content', '{ "model":"x/y"', {}],
    ['keeps native rules ordered before the build agent', '{"permissions":[]}', { permissions: [] }]
  ])('%s', (_name, content, kept) => {
    expect(JSON.parse(withOpenCodeTextGenerationPolicy(content))).toEqual({ ...kept, ...policy })
  })

  it('drops every inline build agent because agents and mode entries replace agent entries', () => {
    const allow = { permission: { '*': 'allow' } }
    const content = JSON.stringify({
      agent: { build: allow, other: allow },
      agents: { build: { model: 'x/y' }, other: allow },
      mode: { build: { model: 'x/y' }, other: allow }
    })
    expect(JSON.parse(withOpenCodeTextGenerationPolicy(content))).toEqual({
      permission,
      agent: { other: allow, build: { model: 'x/y', permission } },
      agents: { other: allow },
      mode: { other: allow }
    })
  })

  it('pins the policy to the agent recipe args select, keeping only its model', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'opencode2',
        model: 'default',
        agentArgs: '--agent writer',
        agentCommandOverride: `OPENCODE_CONFIG_CONTENT='{"agent":{"writer":{"model":"x/y","permission":{"*":"allow"}}}}' opencode2`
      },
      'PROMPT'
    )
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(JSON.parse(result.plan.env?.OPENCODE_CONFIG_CONTENT ?? '')).toEqual({
      permission,
      agent: { writer: { model: 'x/y', permission } }
    })
  })

  it('applies the policy on top of a command override', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'opencode2',
        model: 'default',
        agentCommandOverride: `OPENCODE_CONFIG_CONTENT='{"model":"x/y"}' opencode2`
      },
      'PROMPT'
    )
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.plan.args.slice(0, 2)).toEqual(['run', '--standalone'])
    expect(JSON.parse(result.plan.env?.OPENCODE_CONFIG_CONTENT ?? '')).toEqual({
      model: 'x/y',
      ...policy
    })
  })
})
