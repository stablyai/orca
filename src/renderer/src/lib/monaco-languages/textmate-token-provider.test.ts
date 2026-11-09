import { describe, expect, it, vi } from 'vitest'
import { loadNodeOniguruma } from '../syntax-highlighting/oniguruma-test-harness'
import { loadLeanTextMateGrammar } from './register-lean'
import { loadNimTextMateGrammar } from './register-nim'
import { loadTypstTextMateGrammar } from './register-typst'
import { createTextMateTokensProvider } from './textmate-token-provider'

vi.mock('../syntax-highlighting/oniguruma', () => ({ loadOniguruma: loadNodeOniguruma }))

describe('createTextMateTokensProvider', () => {
  it('converges to an equal state after an edit so Monaco stops re-tokenizing', async () => {
    const provider = await createTextMateTokensProvider({ loadGrammar: loadTypstTextMateGrammar })
    const stored = provider.tokenize('#let width = 12pt', provider.getInitialState()).endState
    const edited = provider.tokenize('#let width = 14pt', provider.getInitialState()).endState

    expect(edited).not.toBe(stored)
    expect(edited.equals(stored)).toBe(true)
    expect(provider.tokenize('$ x', provider.getInitialState()).endState.equals(stored)).toBe(false)
  })

  it.each([
    ['Lean', loadLeanTextMateGrammar, '/-'.repeat(40000), 'def value : Nat := 42'],
    ['Nim', loadNimTextMateGrammar, 'abcdefghij'.repeat(8000), 'proc greet() = discard'],
    ['Typst', loadTypstTextMateGrammar, '#let x = 12pt; *b* $x^2$ '.repeat(2000), '#let y = 2']
  ])(
    'leaves a minified %s line and the lines after it plain instead of freezing',
    async (_language, loadGrammar, longLine, nextLine) => {
      const provider = await createTextMateTokensProvider({ loadGrammar })
      const initial = provider.getInitialState()
      const started = performance.now()
      const long = provider.tokenize(longLine, initial)
      const next = provider.tokenize(nextLine, long.endState)

      // Untimed, these lines take tens of seconds; the length cap skips them outright.
      expect(performance.now() - started).toBeLessThan(1000)
      expect(long.tokens).toHaveLength(1)
      expect(next.tokens).toHaveLength(1)
      expect(next.tokens[0].scopes).toBe(long.tokens[0].scopes)
      expect(next.endState.equals(long.endState)).toBe(true)
      // Shortening the line recolors from the state before it, so the plain tail re-tokenizes.
      const shortened = provider.tokenize(nextLine, initial)
      expect(shortened.tokens.length).toBeGreaterThan(1)
      expect(shortened.endState.equals(long.endState)).toBe(false)
    }
  )
})
