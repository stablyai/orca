import { describe, expect, it } from 'vitest'
import {
  normalizeOrchestrationDefaultWorkerAgent,
  normalizeOrchestrationWorkerEfforts,
  normalizeOrchestrationWorkerModels,
  normalizeOrchestrationWorkerPreferenceUpdates,
  persistedOrchestrationWorkerPreferencesRepaired,
  resolveOrchestrationWorkerEffort,
  supportsLaunchModel
} from './orchestration-worker-model-settings'

describe('orchestration worker model settings', () => {
  it('keeps only a valid default worker agent id', () => {
    expect(normalizeOrchestrationDefaultWorkerAgent('codex')).toBe('codex')
    expect(normalizeOrchestrationDefaultWorkerAgent('unknown')).toBeNull()
    expect(normalizeOrchestrationDefaultWorkerAgent(undefined)).toBeNull()
  })

  it('keeps trimmed model ids only for agents with launch-time model support', () => {
    expect(
      normalizeOrchestrationWorkerModels({
        codex: '  gpt-5.6-luna  ',
        claude: 'opus',
        aider: 'unsupported',
        unknown: 'ignored',
        cursor: false
      })
    ).toEqual({ codex: 'gpt-5.6-luna', claude: 'opus' })
  })

  it('keeps only cataloged launch-time efforts for supported launch agents', () => {
    expect(
      normalizeOrchestrationWorkerEfforts({
        codex: ' max ',
        claude: 'future-effort',
        gemini: 'high',
        aider: 'high',
        grok: 'high'
      })
    ).toEqual({ codex: 'max', grok: 'high' })
  })

  it('validates an effort against its stored model when one is available', () => {
    expect(
      normalizeOrchestrationWorkerEfforts(
        { codex: ' max ', claude: ' high ' },
        { codex: 'gpt-5.5', claude: 'opus' }
      )
    ).toEqual({ claude: 'high' })
  })

  it('resolves effort against the selected model', () => {
    expect(resolveOrchestrationWorkerEffort('codex', 'gpt-5.6-luna', 'max')).toBe('max')
    expect(resolveOrchestrationWorkerEffort('codex', 'gpt-5.6-luna', 'ultra')).toBeUndefined()
    expect(resolveOrchestrationWorkerEffort('codex', 'gpt-5.5', 'max')).toBeUndefined()
    expect(resolveOrchestrationWorkerEffort('codex', 'gpt-5.6-sol', 'ultra')).toBe('ultra')
  })

  it('flags launch-time model support per agent catalog', () => {
    expect(supportsLaunchModel('codex')).toBe(true)
    expect(supportsLaunchModel('claude')).toBe(true)
    expect(supportsLaunchModel('cursor')).toBe(true)
    expect(supportsLaunchModel('gemini')).toBe(false)
    expect(supportsLaunchModel('aider')).toBe(false)
  })

  it('revalidates a stored effort when only the worker model changes', () => {
    expect(
      normalizeOrchestrationWorkerPreferenceUpdates(
        { orchestrationWorkerModels: { codex: 'gpt-5.5' } },
        {
          orchestrationWorkerModels: { codex: 'gpt-5.6-sol' },
          orchestrationWorkerEfforts: { codex: 'max' }
        }
      )
    ).toEqual({
      orchestrationWorkerModels: { codex: 'gpt-5.5' },
      orchestrationWorkerEfforts: {}
    })
  })

  it('leaves a stored effort out of the update when the new model still allows it', () => {
    expect(
      normalizeOrchestrationWorkerPreferenceUpdates(
        { orchestrationWorkerModels: { codex: 'gpt-5.6-luna' } },
        {
          orchestrationWorkerModels: { codex: 'gpt-5.6-sol' },
          orchestrationWorkerEfforts: { codex: 'max' }
        }
      )
    ).toEqual({ orchestrationWorkerModels: { codex: 'gpt-5.6-luna' } })
  })

  it('reports a load-time repair only when stored values differ from the normalized ones', () => {
    const normalized = {
      agent: 'codex' as const,
      models: { codex: 'gpt-5.6-luna' },
      efforts: { codex: 'max' }
    }

    // A profile that stores nothing must not be marked for a save on every load.
    expect(persistedOrchestrationWorkerPreferencesRepaired({}, normalized)).toBe(false)
    expect(
      persistedOrchestrationWorkerPreferencesRepaired(
        {
          orchestrationDefaultWorkerAgent: 'codex',
          orchestrationWorkerModels: { codex: 'gpt-5.6-luna' },
          orchestrationWorkerEfforts: { codex: 'max' }
        },
        normalized
      )
    ).toBe(false)
    expect(
      persistedOrchestrationWorkerPreferencesRepaired(
        { orchestrationWorkerEfforts: { codex: 'max', gemini: 'high' } },
        normalized
      )
    ).toBe(true)
    expect(
      persistedOrchestrationWorkerPreferencesRepaired(
        { orchestrationDefaultWorkerAgent: 'unknown' },
        normalized
      )
    ).toBe(true)
  })
})
