import { describe, expect, it } from 'vitest'
import { isSameOpenAiCompatibleEndpoint } from './openai-compatible-endpoint'

describe('isSameOpenAiCompatibleEndpoint', () => {
  const saved = 'https://api.groq.com/openai/v1'

  it('matches base URLs that differ only in form', () => {
    expect(isSameOpenAiCompatibleEndpoint(saved, ' https://api.groq.com/openai/v1/ ')).toBe(true)
    expect(isSameOpenAiCompatibleEndpoint(saved, 'https://api.groq.com/openai/v1///')).toBe(true)
    expect(
      isSameOpenAiCompatibleEndpoint(saved, 'https://api.groq.com/openai/v1/audio/transcriptions')
    ).toBe(true)
  })

  it('rejects a different endpoint', () => {
    expect(isSameOpenAiCompatibleEndpoint(saved, 'https://api.mistral.ai/v1')).toBe(false)
  })

  it('rejects invalid URLs without throwing', () => {
    expect(isSameOpenAiCompatibleEndpoint(saved, 'api.groq.com/openai/v1')).toBe(false)
    expect(isSameOpenAiCompatibleEndpoint('', '')).toBe(false)
  })
})
