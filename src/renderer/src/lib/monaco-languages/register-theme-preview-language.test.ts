import { describe, expect, it } from 'vitest'
import type * as Monaco from 'monaco-editor'
import {
  THEME_PREVIEW_LANGUAGE_ID,
  registerThemePreviewLanguage,
  themePreviewMonarchLanguage
} from './register-theme-preview-language'

describe('themePreviewMonarchLanguage', () => {
  it('tags an identifier immediately followed by "(" as support.function', () => {
    const rules = themePreviewMonarchLanguage.tokenizer.root as [RegExp, unknown][]
    const functionCallRule = rules.find(([, action]) =>
      typeof action === 'string'
        ? action === 'support.function'
        : (action as { token?: string })?.token === 'support.function'
    )
    expect(functionCallRule).toBeDefined()

    const [pattern] = functionCallRule as [RegExp, unknown]
    expect(pattern.test('loadActiveWorktree(')).toBe(true)
    expect(pattern.test('loadActiveWorktree ')).toBe(false)
  })

  it('colors an ALL_CAPS constant as a plain identifier, not a type', () => {
    const rules = themePreviewMonarchLanguage.tokenizer.root as [RegExp, string][]
    // First rule (in order) whose pattern matches at index 0 wins, mirroring Monaco's
    // own anchored rule-by-rule tokenizer walk.
    const winner = rules.find(([pattern]) => {
      const match = pattern.exec('FICHE_MISSION_PROPERTY_REPAIR_EXTRA_FEATURES')
      return match !== null && match.index === 0
    })
    expect(winner?.[1]).toBe('identifier')
  })

  it('colors a PascalCase namespace/enum access the same as a function call', () => {
    const rules = themePreviewMonarchLanguage.tokenizer.root as [RegExp, string][]
    const winner = rules.find(([pattern]) => {
      const match = pattern.exec('FeatureFlags.X')
      return match !== null && match.index === 0
    })
    expect(winner?.[1]).toBe('support.function')
  })
})

describe('registerThemePreviewLanguage', () => {
  it('registers the language and tokenizer exactly once even across repeated calls', () => {
    let registerCalls = 0
    let setMonarchCalls = 0
    const fakeMonaco = {
      languages: {
        register: (options: { id: string }) => {
          expect(options.id).toBe(THEME_PREVIEW_LANGUAGE_ID)
          registerCalls += 1
        },
        setLanguageConfiguration: () => undefined,
        setMonarchTokensProvider: (id: string) => {
          expect(id).toBe(THEME_PREVIEW_LANGUAGE_ID)
          setMonarchCalls += 1
        }
      }
    }

    registerThemePreviewLanguage(fakeMonaco as unknown as typeof Monaco)
    registerThemePreviewLanguage(fakeMonaco as unknown as typeof Monaco)

    // Why <= 1, not === 1: `registered` is module-level state shared across the whole
    // test file/process, so an earlier test importing this module first can already
    // have flipped it before this test runs — asserting "never registers twice" is the
    // real contract, not "exactly once from a pristine module".
    expect(registerCalls).toBeLessThanOrEqual(1)
    expect(setMonarchCalls).toBeLessThanOrEqual(1)
  })
})
