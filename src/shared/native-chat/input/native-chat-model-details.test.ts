import { describe, expect, it } from 'vitest'
import { parseNativeChatModelDetails, withListedModelDetails } from './native-chat-model-details'

describe('native chat model details', () => {
  it('parses a positive maximum output token count', () => {
    expect(parseNativeChatModelDetails({ maxOutputTokens: 16_384 })).toEqual({
      maxOutputTokens: 16_384
    })
    expect(parseNativeChatModelDetails({ maxOutputTokens: 0 })).toBeUndefined()
  })

  it('keeps fresh session details ahead of older catalog details', () => {
    const [model] = withListedModelDetails(
      [{ id: 'provider/model', details: { provider: 'fresh', maxOutputTokens: 32_768 } }],
      [{ id: 'provider/model', details: { provider: 'stale', contextWindowTokens: 128_000 } }]
    )
    expect(model?.details).toEqual({
      provider: 'fresh',
      maxOutputTokens: 32_768,
      contextWindowTokens: 128_000
    })
  })
})
