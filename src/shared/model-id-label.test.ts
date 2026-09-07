import { describe, expect, it } from 'vitest'
import { labelFromModelId } from './model-id-label'

describe('labelFromModelId', () => {
  it('titlecases hyphenated segments', () => {
    expect(labelFromModelId('grok-build')).toBe('Grok Build')
    expect(labelFromModelId('grok')).toBe('Grok')
  })

  it('keeps short numeric segments verbatim', () => {
    expect(labelFromModelId('grok-4.5')).toBe('Grok 4.5')
    expect(labelFromModelId('grok-4.5-fast')).toBe('Grok 4.5 Fast')
  })

  it('special-cases the gpt segment', () => {
    expect(labelFromModelId('gpt-5.3-codex')).toBe('GPT 5.3 Codex')
    expect(labelFromModelId('GPT-5')).toBe('GPT 5')
  })

  it('splits provider-prefixed ids on the slash', () => {
    expect(labelFromModelId('xai/grok-4.5')).toBe('Xai Grok 4.5')
  })

  it('drops empty segments from repeated or edge separators', () => {
    expect(labelFromModelId('grok--4.5')).toBe('Grok 4.5')
    expect(labelFromModelId('-grok-')).toBe('Grok')
    expect(labelFromModelId('')).toBe('')
  })

  it('uppercases only digit-led segments of three characters or fewer', () => {
    expect(labelFromModelId('grok-4o')).toBe('Grok 4O')
    expect(labelFromModelId('grok-2026.07.19')).toBe('Grok 2026.07.19')
  })
})
