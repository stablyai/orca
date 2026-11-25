import { describe, expect, it } from 'vitest'
import { automationRunErrorText } from './automation-run-error-copy'

const LONG_MODEL = 'sample-preview-'.padEnd(120, 'x')

function modelFailure(model: string) {
  return {
    error: 'stored',
    errorCode: 'agentModelUnavailable' as const,
    errorParams: { agent: 'codex', model }
  }
}

describe('automationRunErrorText model names', () => {
  it('keeps the whole model name by default', () => {
    expect(automationRunErrorText(modelFailure(LONG_MODEL))).toContain(LONG_MODEL)
  })

  it('shortens a long model name in the middle when asked', () => {
    const text = automationRunErrorText(modelFailure(LONG_MODEL), undefined, {
      maxModelLength: 40
    })
    const shown = /use (.+)\.$/.exec(text ?? '')?.[1] ?? ''
    expect(Array.from(shown)).toHaveLength(40)
    expect(shown.startsWith('sample-preview-')).toBe(true)
    expect(shown).toContain('…')
    expect(shown.endsWith('x')).toBe(true)
  })

  it('leaves a model name that already fits unchanged', () => {
    const text = automationRunErrorText(modelFailure('model-beta'), undefined, {
      maxModelLength: 40
    })
    expect(text).toContain('model-beta.')
    expect(text).not.toContain('…')
  })
})
