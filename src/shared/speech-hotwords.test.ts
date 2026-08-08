import { describe, expect, it } from 'vitest'
import {
  MAX_SPEECH_HOTWORD_LENGTH,
  MAX_SPEECH_HOTWORDS,
  normalizeSpeechHotwords
} from './speech-hotwords'

describe('normalizeSpeechHotwords', () => {
  it('trims terms and deduplicates mixed Chinese and English vocabulary', () => {
    expect(normalizeSpeechHotwords([' Orca ', 'orca', 'Qwen3-ASR', '中文术语'])).toEqual([
      'Orca',
      'Qwen3-ASR',
      '中文术语'
    ])
  })

  it('drops non-strings, control characters, score delimiters, and oversized terms', () => {
    expect(
      normalizeSpeechHotwords([
        null,
        42,
        '',
        'line\nbreak',
        'tab\tbreak',
        'weight:3.0',
        'paragraph\u2029break',
        'x'.repeat(MAX_SPEECH_HOTWORD_LENGTH + 1),
        'PowerShell'
      ])
    ).toEqual(['PowerShell'])
  })

  it('bounds vocabulary received across IPC', () => {
    const input = Array.from({ length: MAX_SPEECH_HOTWORDS + 20 }, (_, index) => `term-${index}`)

    expect(normalizeSpeechHotwords(input)).toHaveLength(MAX_SPEECH_HOTWORDS)
    expect(normalizeSpeechHotwords(input).at(-1)).toBe(`term-${MAX_SPEECH_HOTWORDS - 1}`)
  })

  it('returns an empty list for non-array input', () => {
    expect(normalizeSpeechHotwords('Orca')).toEqual([])
  })
})
