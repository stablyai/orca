import { describe, expect, it } from 'vitest'
import { planCommitMessageGeneration } from './commit-message-plan'
import { parseOmpModelList } from './omp-model-list-probe'
import { resolveThinkingLevel } from './source-control-ai-model-selection'
import { getDefaultSourceControlAiSettings } from './source-control-ai-settings'

describe('OMP text generation thinking', () => {
  it('retires a saved thinking value when the model no longer advertises it', () => {
    const model = parseOmpModelList(
      JSON.stringify({
        models: [
          {
            provider: 'custom',
            id: 'model',
            thinking: ['low', 'high']
          }
        ]
      })
    )[0]
    const source = getDefaultSourceControlAiSettings()
    source.selectedThinkingByModel[model.id] = 'max'
    expect(
      resolveThinkingLevel({
        model,
        source,
        legacy: undefined,
        repoOverrides: undefined,
        operation: 'commitMessage'
      })
    ).toBeUndefined()
    source.selectedThinkingByModel[model.id] = 'high'
    expect(
      resolveThinkingLevel({
        model,
        source,
        legacy: undefined,
        repoOverrides: undefined,
        operation: 'commitMessage'
      })
    ).toBe('high')
  })

  it.each([
    { saved: undefined, expected: undefined },
    { saved: 'off', expected: 'off' },
    { saved: 'auto', expected: 'auto' },
    { saved: 'low', expected: 'low' },
    { saved: 'max', expected: undefined }
  ])('plans only the advertised saved preference $saved', ({ saved, expected }) => {
    const model = parseOmpModelList(
      JSON.stringify({ models: [{ provider: 'custom', id: 'model', thinking: ['low', 'high'] }] })
    )[0]
    const source = getDefaultSourceControlAiSettings()
    if (saved !== undefined) {
      source.selectedThinkingByModel[model.id] = saved
    }
    const thinkingLevel = resolveThinkingLevel({
      model,
      source,
      legacy: undefined,
      repoOverrides: undefined,
      operation: 'commitMessage'
    })
    expect(thinkingLevel).toBe(expected)
    const result = planCommitMessageGeneration(
      { agentId: 'omp', model: model.id, thinkingLevel },
      'Generate'
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.args.includes('--thinking')).toBe(expected !== undefined)
      if (expected !== undefined) {
        expect(result.plan.args[result.plan.args.indexOf('--thinking') + 1]).toBe(expected)
      }
    }
  })

  it.each(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'])(
    'passes native thinking %s to the actual CLI plan',
    (thinkingLevel) => {
      const result = planCommitMessageGeneration(
        { agentId: 'omp', model: 'custom/model', thinkingLevel },
        'Generate a commit'
      )
      expect(result).toMatchObject({
        ok: true,
        plan: {
          binary: 'omp',
          stdinPayload: 'Generate a commit',
          args: expect.arrayContaining(['--model', 'custom/model', '--thinking', thinkingLevel])
        }
      })
      if (result.ok) {
        expect(result.plan.args.filter((arg) => arg === '--thinking')).toHaveLength(1)
      }
    }
  )

  it('leaves configured thinking untouched without an explicit selection', () => {
    const result = planCommitMessageGeneration(
      { agentId: 'omp', model: 'custom/model' },
      'Generate a branch'
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.args).not.toContain('--thinking')
    }
  })

  it.each(['ultra', 'turbo', 'inherit', 'config-default'])(
    'refuses non-native thinking %s',
    (thinkingLevel) => {
      expect(
        planCommitMessageGeneration(
          { agentId: 'omp', model: 'custom/model', thinkingLevel },
          'Generate'
        )
      ).toMatchObject({ ok: false })
    }
  )

  it('uses one user override instead of duplicate thinking flags', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'omp',
        model: 'custom/model',
        thinkingLevel: 'max',
        agentArgs: '--thinking low'
      },
      'Generate a review'
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.args.filter((arg) => arg === '--thinking')).toHaveLength(1)
      expect(result.plan.args[result.plan.args.indexOf('--thinking') + 1]).toBe('low')
      expect(result.plan.args).not.toContain('max')
    }
  })

  it('preserves unrelated arguments when an equals-form thinking flag overrides preferences', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'omp',
        model: 'custom/model',
        thinkingLevel: 'high',
        agentArgs: '--thinking=auto --no-extensions'
      },
      'Generate'
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.args).toContain('--thinking=auto')
      expect(result.plan.args).toContain('--no-extensions')
      expect(result.plan.args).not.toContain('--thinking')
      expect(result.plan.args).not.toContain('high')
    }
  })
})
