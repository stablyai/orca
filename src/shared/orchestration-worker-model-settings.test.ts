import { describe, expect, it } from 'vitest'
import {
  normalizeOrchestrationDefaultWorkerAgent,
  normalizeOrchestrationWorkerEfforts,
  normalizeOrchestrationWorkerModels,
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
    ).toEqual({ codex: 'max' })
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
})
