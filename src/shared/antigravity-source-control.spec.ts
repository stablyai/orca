import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import { resolveSourceControlAiForOperation } from './source-control-ai'
import { planCommitMessageGeneration } from './commit-message-plan'

describe('Antigravity source-control model selection', () => {
  for (const host of ['local', 'ssh:verification-host']) {
    for (const operation of ['commitMessage', 'branchName', 'pullRequest'] as const) {
      it(`${operation} on ${host} falls back from a retired saved model to the CLI configuration`, () => {
        const settings = getDefaultSettings('/tmp')
        settings.sourceControlAi = {
          ...settings.sourceControlAi!,
          enabled: true,
          agentId: 'antigravity',
          selectedModelByAgent: { antigravity: 'Gemini 3.5 Flash (Medium)' },
          selectedModelByAgentByHost: {
            [host]: { antigravity: 'Gemini 3.5 Flash (Medium)' }
          },
          discoveredModelsByAgent: {},
          discoveredModelsByAgentByHost: {}
        }
        const result = resolveSourceControlAiForOperation({
          settings,
          repo: null,
          operation,
          discoveryHostKey: host
        })
        expect(result.ok).toBe(true)
        if (!result.ok) {
          throw new Error(result.error)
        }
        expect(result.value.params.model).toBe('default')
        const plan = planCommitMessageGeneration(result.value.params, 'Write Git text')
        expect(plan.ok).toBe(true)
        if (!plan.ok) {
          throw new Error(plan.error)
        }
        expect(plan.plan.args).toEqual(['--print=Write Git text', '--sandbox'])
        expect(plan.plan.stdinPayload).toBeNull()
      })
    }
  }

  it('lets explicit recipe arguments override the discovered model and requested effort once', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'antigravity',
        model: 'gemini-3.8-flash-medium',
        thinkingLevel: 'medium',
        agentArgs: '--model gemini-3.7-flash-low --effort low'
      },
      'Write Git text'
    )
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.plan.args.filter((arg) => arg === '--model')).toHaveLength(1)
    expect(result.plan.args.filter((arg) => arg === '--effort')).toHaveLength(1)
    expect(result.plan.args).not.toContain('gemini-3.8-flash-medium')
    expect(result.plan.args).not.toContain('medium')
    expect(result.plan.args).toContain('gemini-3.7-flash-low')
    expect(result.plan.args).toContain('low')
  })
})
