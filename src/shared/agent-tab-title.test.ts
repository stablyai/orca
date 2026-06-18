import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deriveGeneratedTabTitle,
  GENERATED_TAB_TITLE_MAX_LENGTH,
  GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT
} from './agent-tab-title'

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('preserves non-ASCII title text while folding Unicode whitespace', () => {
    expect(deriveGeneratedTabTitle('Please 修正\u00a0résumé\t検索\u3000１２３!!!')).toBe(
      '修正 résumé 検索 １２３'
    )
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

  it('bounds normalization work for paste-sized prompts before truncating the title', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const prompt = `Please fix \`src/auth.ts\` ${'large pasted text '.repeat(5000)}`

    const title = deriveGeneratedTabTitle(prompt)

    expect(title).toBeTruthy()
    expect(title!.length).toBeLessThanOrEqual(GENERATED_TAB_TITLE_MAX_LENGTH)
    const replaceContextLengths = replaceSpy.mock.contexts.map((context) => String(context).length)
    const splitContextLengths = splitSpy.mock.contexts.map((context) => String(context).length)
    expect(Math.max(...replaceContextLengths)).toBeLessThanOrEqual(
      GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT
    )
    expect(Math.max(...splitContextLengths)).toBeLessThanOrEqual(
      GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT
    )
    expect(
      replaceSpy.mock.calls.filter(
        ([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+'
      )
    ).toHaveLength(0)
  })
})
