import { describe, expect, it } from 'vitest'
import { buildCommitMessageGenerationParams } from './text-generation-params'
import {
  ON_DEVICE_TEXT_GENERATION_ID,
  ON_DEVICE_TEXT_GENERATION_MODEL_ID
} from '../../../../../../shared/on-device-text-generation'

const base = {
  agentId: 'claude' as const,
  model: 'claude-sonnet',
  customPrompt: 'Write short subjects.'
}

describe('buildCommitMessageGenerationParams', () => {
  it('carries configured instructions to the provider', () => {
    const params = buildCommitMessageGenerationParams({
      agentId: ON_DEVICE_TEXT_GENERATION_ID,
      commandTemplate: '{basePrompt}',
      baseParams: base,
      settings: null
    })

    expect(params).toMatchObject({
      agentId: ON_DEVICE_TEXT_GENERATION_ID,
      model: ON_DEVICE_TEXT_GENERATION_MODEL_ID,
      customPrompt: 'Write short subjects.'
    })
  })

  it('leaves CLI params without customPrompt, which their template already carries', () => {
    const params = buildCommitMessageGenerationParams({
      agentId: 'claude',
      commandTemplate: '{basePrompt}',
      baseParams: { ...base, customPrompt: 'Write short subjects.' },
      settings: null
    })

    expect(params).not.toHaveProperty('customPrompt')
  })
})
