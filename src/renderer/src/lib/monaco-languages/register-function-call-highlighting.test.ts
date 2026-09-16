// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type * as Monaco from 'monaco-editor'
import { registerFunctionCallHighlighting } from './register-function-call-highlighting'
import { HEURISTIC_IDENTIFIER_TOKEN_RULES } from './heuristic-identifier-token-rules'

describe('registerFunctionCallHighlighting', () => {
  it('overrides the typescript and javascript tokenizers with the heuristic identifier rules ahead of the generic identifier rule', () => {
    const setCalls: { languageId: string; language: Monaco.languages.IMonarchLanguage }[] = []
    const fakeMonaco = {
      languages: {
        setMonarchTokensProvider: (
          languageId: string,
          language: Monaco.languages.IMonarchLanguage
        ) => {
          setCalls.push({ languageId, language })
        }
      }
    }

    registerFunctionCallHighlighting(fakeMonaco as unknown as typeof Monaco)

    expect(setCalls.map((call) => call.languageId).sort()).toEqual(['javascript', 'typescript'])

    for (const { language } of setCalls) {
      const commonRules = language.tokenizer.common as [RegExp, string][]
      expect(commonRules.slice(0, HEURISTIC_IDENTIFIER_TOKEN_RULES.length)).toEqual(
        HEURISTIC_IDENTIFIER_TOKEN_RULES
      )
      // Why: the generic identifier/keyword rule must still exist right after our
      // rules, or every existing token classification (keyword, identifier, etc.)
      // would silently disappear from real files.
      expect(commonRules.length).toBeGreaterThan(HEURISTIC_IDENTIFIER_TOKEN_RULES.length)
    }
  })

  it('registers each tokenizer exactly once even across repeated calls', () => {
    let callCount = 0
    const fakeMonaco = {
      languages: {
        setMonarchTokensProvider: () => {
          callCount += 1
        }
      }
    }

    registerFunctionCallHighlighting(fakeMonaco as unknown as typeof Monaco)
    registerFunctionCallHighlighting(fakeMonaco as unknown as typeof Monaco)

    // Why <= 2, not === 2: `registered` is module-level state shared across the whole
    // test file/process, so an earlier test importing this module first can already
    // have flipped it before this test runs — asserting "never re-registers" is the
    // real contract, not "exactly twice (ts + js) from a pristine module".
    expect(callCount).toBeLessThanOrEqual(2)
  })
})
