import { describe, expect, it } from 'vitest'
import {
  formatArchitectureViewError,
  isActiveArchitectureModelChange,
  sanitizeClientModelName
} from './useArchitectureModelSession'

describe('architecture model session helpers', () => {
  it('normalizes renderer model names to the Scryer default model name', () => {
    expect(sanitizeClientModelName(null)).toBe('model')
    expect(sanitizeClientModelName('Model.scry')).toBe('model')
    expect(sanitizeClientModelName('Release Plan')).toBe('release-plan')
  })

  it('treats planned.scry as the active plan layer for the default model only', () => {
    expect(isActiveArchitectureModelChange('model.scry', 'model')).toBe(true)
    expect(isActiveArchitectureModelChange('planned.scry', 'model')).toBe(true)
    expect(isActiveArchitectureModelChange('planned.scry', 'release-plan')).toBe(false)
    expect(isActiveArchitectureModelChange('release-plan.scry', 'release-plan')).toBe(true)
  })

  it('formats strict model unknown fields as unsupported Architecture fields', () => {
    expect(
      formatArchitectureViewError({
        code: 'incompatible_model',
        message: 'Scryer model failed schema validation',
        details: { reason: 'unknown_fields', fields: ['nodes[0].data', 'flows'] }
      })
    ).toBe('Scryer model contains unsupported fields: nodes[0].data, flows')
  })

  it('formats strict model unknown fields from field errors when details omit fields', () => {
    expect(
      formatArchitectureViewError({
        code: 'incompatible_model',
        message: 'Scryer model failed schema validation',
        details: { reason: 'unknown_fields' },
        fieldErrors: [{ path: 'flows', message: 'Unrecognized key', code: 'unrecognized_keys' }]
      })
    ).toBe('Scryer model contains unsupported fields: flows')
  })
})
