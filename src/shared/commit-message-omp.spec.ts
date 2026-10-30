import { planCommitMessageGeneration } from './commit-message-plan'
import { getAgentModelProbeSpec } from './agent-model-probe-spec'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import { getCommitMessageAgentSpec } from './commit-message-agent-spec'
import { resolveSourceControlAiForOperation } from './source-control-ai'

describe('OMP Source Control AI', () => {
  it.each(['commitMessage', 'pullRequest', 'branchName'] as const)(
    'uses the configured OMP default for %s without requiring a model override',
    (operation) => {
      const settings = getDefaultSettings('/tmp')
      settings.defaultTuiAgent = 'omp'
      const result = resolveSourceControlAiForOperation({ settings, repo: null, operation })
      expect(result).toMatchObject({
        ok: true,
        value: { params: { agentId: 'omp', model: 'default' } }
      })
    }
  )
  it('plans file delivery with tools and extensions disabled', () => {
    const spec = getCommitMessageAgentSpec('omp')
    expect(spec?.promptDelivery).toBe('file')
    if (!spec) {
      throw new Error('Missing OMP spec')
    }
    const args = spec.buildArgs({ prompt: '@{prompt-file}', model: 'default' })
    expect(args).toEqual([
      '--print',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--mode',
      'text',
      '@{prompt-file}'
    ])
    expect(
      spec?.buildArgs({
        prompt: '@{prompt-file}',
        model: 'provider/exact-model',
        thinkingLevel: 'low'
      })
    ).toEqual([
      ...args.slice(0, -1),
      '--model',
      'provider/exact-model',
      '--thinking',
      'low',
      '@{prompt-file}'
    ])
  })
  it('discovers provider-qualified models through the existing OMP JSON parser', () => {
    const discovery = getCommitMessageAgentSpec('omp')?.modelDiscovery
    expect(discovery?.args).toEqual(['models', '--json'])
    expect(
      discovery?.parse(
        JSON.stringify({
          models: [{ provider: 'provider', id: 'm', selector: 'provider/m', name: 'Model' }]
        })
      )
    ).toEqual([{ id: 'provider/m', label: 'Model', description: 'provider' }])
  })
  it.each(['escape', 'literal'] as const)(
    'plans recipe model overrides with %s path parsing',
    (backslash) => {
      const prompt = `diff --git a/a b/a\n${'large patch\n'.repeat(10000)}`
      const result = planCommitMessageGeneration(
        {
          agentId: 'omp',
          model: 'provider/model',
          thinkingLevel: 'medium',
          backslash,
          agentCommandOverride: 'OMP_ENV=value omp --model provider/prefix --thinking high',
          agentArgs: '--model provider/override --thinking low --verbose --'
        },
        prompt
      )
      expect(result.ok).toBe(true)
      if (!result.ok) {
        throw new Error(result.error)
      }
      expect(result.plan.stdinPayload).toBeNull()
      expect(result.plan.promptFile).toEqual({
        content: prompt,
        argIndex: result.plan.args.indexOf('@{prompt-file}')
      })
      expect(result.plan.env).toEqual({ OMP_ENV: 'value' })
      expect(result.plan.args.slice(-3)).toEqual(['@{prompt-file}', '--verbose', '--'])
      expect(result.plan.args.filter((arg) => arg === '--thinking')).toHaveLength(1)
      expect(result.plan.args).toContain('low')
      expect(result.plan.args).not.toContain('high')
      expect(result.plan.args).not.toContain(prompt)
      expect(result.plan.args.filter((arg) => arg === '--model')).toHaveLength(1)
      expect(result.plan.args).toContain('provider/override')
      expect(result.plan.args).not.toContain('provider/model')
    }
  )
})

it('does not expose OMP config default as a terminal discovery model', () => {
  const spec = getAgentModelProbeSpec('omp')
  expect(spec?.models.some((model) => model.id === 'default')).toBe(false)
  expect(spec?.defaultModelId).toBe('')
})
