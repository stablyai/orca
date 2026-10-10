import { describe, expect, it } from 'vitest'
import { MAX_CLOUD_SPEECH_API_KEY_LENGTH, SpeechProviderKeySave } from './speech-params'

describe('SpeechProviderKeySave', () => {
  it('accepts a printable key with surrounding whitespace', () => {
    expect(
      SpeechProviderKeySave.safeParse({ providerId: 'soniox', apiKey: ' key-1 ' }).success
    ).toBe(true)
  })

  it('rejects a key with an embedded line break or control character', () => {
    for (const apiKey of ['abc\n123', 'abc\r123', 'abc\u0000123', 'abc 123']) {
      expect(SpeechProviderKeySave.safeParse({ providerId: 'soniox', apiKey }).success).toBe(false)
    }
  })

  it('rejects an oversized key before it reaches a request header', () => {
    const apiKey = 'k'.repeat(MAX_CLOUD_SPEECH_API_KEY_LENGTH + 1)
    expect(SpeechProviderKeySave.safeParse({ providerId: 'soniox', apiKey }).success).toBe(false)
  })
})
