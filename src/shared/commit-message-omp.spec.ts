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
  it('delivers large diffs on stdin and keeps generation isolated from tools and extensions', () => {
    const spec = getCommitMessageAgentSpec('omp')
    expect(spec?.promptDelivery).toBe('stdin')
    if (!spec) {
      throw new Error('Missing OMP spec')
    }
    const args = spec.buildArgs({ prompt: 'large diff', model: 'default' })
    expect(args).toEqual([
      '--print',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--mode',
      'text'
    ])
    expect(
      spec?.buildArgs({ prompt: '', model: 'provider/exact-model', thinkingLevel: 'low' })
    ).toEqual([...args, '--model', 'provider/exact-model', '--thinking', 'low'])
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
          backslash,
          agentArgs: '--model provider/override'
        },
        prompt
      )
      expect(result.ok).toBe(true)
      if (!result.ok) {
        throw new Error(result.error)
      }
      expect(result.plan.stdinPayload).toBe(prompt)
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
