import { describe, expect, it } from 'vitest'
import {
  buildConversationNamePrompt,
  clampConversationNameFirstPrompt,
  sanitizeGeneratedConversationName
} from './conversation-name-generation'

describe('conversation name generation', () => {
  it('bounds the first prompt in both the built-in prompt and template variable', () => {
    const firstPrompt = `Start ${'x'.repeat(5000)}`
    const clamped = clampConversationNameFirstPrompt(firstPrompt)
    expect(clamped).toHaveLength(4000)
    expect(buildConversationNamePrompt({ firstPrompt })).toContain(clamped)
    expect(buildConversationNamePrompt({ firstPrompt })).not.toContain('x'.repeat(5000))
  })

  it('takes the first answer line and removes title formatting and a reasoning preamble', () => {
    expect(
      sanitizeGeneratedConversationName(
        '<think>draft wording</think>\n# **Title: "Fix login flow"**\nIgnore this'
      )
    ).toBe('Fix login flow')
  })

  it('cuts long names at a word boundary and rejects empty output', () => {
    const name = sanitizeGeneratedConversationName(
      'Improve authentication flow and update session recovery for everyone'
    )
    expect(name).toBe('Improve authentication flow and update session')
    expect(name?.length).toBeLessThanOrEqual(48)
    expect(sanitizeGeneratedConversationName('  \n  ')).toBeNull()
    expect(sanitizeGeneratedConversationName('<think>no answer</think>')).toBeNull()
    expect(sanitizeGeneratedConversationName('<think>unfinished')).toBeNull()
  })
})
