import { describe, expect, it } from 'vitest'
import {
  MAX_DICTATION_CORRECTION_CODE_UNITS,
  correctSpeechTranscript,
  normalizeDictationCorrectionMode
} from './speech-transcript-correction'

describe('correctSpeechTranscript', () => {
  it('converts spoken Chinese punctuation and restores mixed-language vocabulary', () => {
    expect(correctSpeechTranscript('你好 逗号 我们用 q w e n 3 a s r 句号', ['Qwen3-ASR'])).toBe(
      '你好，我们用 Qwen3-ASR。'
    )
  })

  it('converts standalone English punctuation without matching word fragments', () => {
    expect(
      correctSpeechTranscript('run power shell comma then periodic task period', ['PowerShell'])
    ).toBe('run PowerShell, then periodic task.')
  })

  it('preserves explicit paragraph structure from spoken commands', () => {
    expect(correctSpeechTranscript('第一行 换行 second line new paragraph third line')).toBe(
      '第一行\nsecond line\n\nthird line'
    )
  })

  it('prefers the longest vocabulary term at a word boundary', () => {
    expect(correctSpeechTranscript('use power shell core', ['PowerShell', 'PowerShell Core'])).toBe(
      'use PowerShell Core'
    )
  })

  it('does not restore vocabulary across punctuation segment breaks', () => {
    expect(correctSpeechTranscript('q,w,e,n,3,a,s,r', ['Qwen3-ASR'])).toBe('q,w,e,n,3,a,s,r')
  })

  it('keeps oversized transcripts unchanged to bound synchronous post-processing', () => {
    const text = ` ${'a'.repeat(MAX_DICTATION_CORRECTION_CODE_UNITS + 1)} `
    expect(correctSpeechTranscript(text, ['A'])).toBe(text.trim())
  })
})

describe('normalizeDictationCorrectionMode', () => {
  it('accepts supported modes and defaults unknown values off', () => {
    expect(normalizeDictationCorrectionMode('preview')).toBe('preview')
    expect(normalizeDictationCorrectionMode('auto')).toBe('auto')
    expect(normalizeDictationCorrectionMode('cloud')).toBe('off')
    expect(normalizeDictationCorrectionMode(null)).toBe('off')
  })
})
