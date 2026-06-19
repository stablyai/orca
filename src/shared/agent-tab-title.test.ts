import { describe, expect, it } from 'vitest'
import { deriveGeneratedTabTitle, GENERATED_TAB_TITLE_MAX_LENGTH } from './agent-tab-title'

describe('deriveGeneratedTabTitle', () => {
  it('derives a short title from the first useful prompt clause', () => {
    expect(
      deriveGeneratedTabTitle('Can you please refactor the auth middleware to use JWT tokens?')
    ).toBe('Refactor the auth middleware to use JWT')
  })

  it('strips markup, links, emoji, and punctuation from generated titles', () => {
    expect(
      deriveGeneratedTabTitle('Please fix `src/auth.ts`!!! https://example.com 🔥 then add tests')
    ).toBe('Fix src auth')
  })

  it('keeps useful text after common issue prefixes', () => {
    expect(deriveGeneratedTabTitle('Issue #2056: Opt-in generated tab titles for agents')).toBe(
      'Opt in generated tab titles for agents'
    )
  })

  it('bounds titles to the maximum length without adding punctuation', () => {
    const title = deriveGeneratedTabTitle(
      'I want to replace the terminal reconnection hydration flow with a safer retry path'
    )

    expect(title).toBeTruthy()
    expect(title!.length).toBeLessThanOrEqual(GENERATED_TAB_TITLE_MAX_LENGTH)
    expect(title).toMatch(/^[\p{L}\p{N}\s]+$/u)
  })

  it('returns null when the prompt has no useful title text', () => {
    expect(deriveGeneratedTabTitle('please!!!')).toBeNull()
  })
})
