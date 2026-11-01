import { describe, expect, it } from 'vitest'
import { labelFromModelId } from './model-id-label'

describe('labelFromModelId', () => {
  it('dots the version an id spells with dashes, never a date', () => {
    expect(labelFromModelId('claude-opus-5-5')).toBe('Claude Opus 5.5')
    expect(labelFromModelId('claude-opus-5-5[1m]')).toBe('Claude Opus 5.5 (1M context)')
    expect(labelFromModelId('claude-3-5-sonnet-20241022')).toBe('Claude 3.5 Sonnet 20241022')
    expect(labelFromModelId('xai/grok-4-1-fast')).toBe('Xai Grok 4.1 Fast')
    expect(labelFromModelId('gpt-4o-2024-08-06')).toBe('GPT 4O 2024 08 06')
    expect(labelFromModelId('llama-3-8b')).toBe('Llama 3 8B')
  })
})
