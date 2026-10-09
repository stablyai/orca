import { describe, expect, it, vi } from 'vitest'
import { loadNodeOniguruma } from '../syntax-highlighting/oniguruma-test-harness'
import { loadNimTextMateGrammar } from './register-nim'
import { loadTypstTextMateGrammar } from './register-typst'
import { createTextMateTokensProvider } from './textmate-token-provider'

vi.mock('../syntax-highlighting/oniguruma', () => ({ loadOniguruma: loadNodeOniguruma }))

describe('createTextMateTokensProvider', () => {
  it('tokenizes Nim with the vendored TextMate grammar', async () => {
    const provider = await createTextMateTokensProvider({ loadGrammar: loadNimTextMateGrammar })

    const procLine = provider.tokenize('proc greet(name: string) =', provider.getInitialState())
    const procScopes = procLine.tokens.map((token) => token.scopes)
    expect(procScopes).toContain('keyword.other')
    expect(procScopes).toContain('entity.name.function.nim')
    expect(procScopes).toContain('storage.type.concrete.nim')

    const commentLine = provider.tokenize('# hello', provider.getInitialState())
    expect(commentLine.tokens.map((token) => token.scopes)).toContain(
      'comment.line.number-sign.nim'
    )
  })

  it('tokenizes Typst markup, code, and math through the lazy grammar loader', async () => {
    const provider = await createTextMateTokensProvider({ loadGrammar: loadTypstTextMateGrammar })
    const scopesOf = (line: string) =>
      provider.tokenize(line, provider.getInitialState()).tokens.map((token) => token.scopes)

    expect(scopesOf('#let width = 12pt')).toEqual(
      expect.arrayContaining(['keyword.other.typst', 'constant.numeric.length.typst'])
    )
    expect(scopesOf('#set text(font: "Inter")')).toEqual(
      expect.arrayContaining(['entity.name.function.typst', 'string.quoted.double.typst'])
    )
    expect(scopesOf('// note')).toContain('comment.line.double-slash.typst')
    expect(scopesOf('$ sum_(k=0)^n k $')).toContain('string.other.math.typst')
  })

  it.each([
    ['```rust', 'let x = 1', '```', '#let y = 2'],
    ['````', '```', '````', '#let y = 2']
  ])('carries a Typst raw block until its matching fence closes (%s)', async (...lines) => {
    const provider = await createTextMateTokensProvider({ loadGrammar: loadTypstTextMateGrammar })

    let state = provider.getInitialState()
    const lineScopes = lines.map((line) => {
      const result = provider.tokenize(line, state)
      state = result.endState
      return result.tokens.map((token) => token.scopes)
    })

    expect(lineScopes[1]).toEqual(['markup.raw.block.typst'])
    expect(lineScopes[3]).toContain('keyword.other.typst')
  })

  it('carries Typst math across lines and returns to code after the closing dollar', async () => {
    const provider = await createTextMateTokensProvider({ loadGrammar: loadTypstTextMateGrammar })
    const opening = provider.tokenize('$', provider.getInitialState())
    const clone = opening.endState.clone()
    expect(clone.equals(opening.endState)).toBe(true)
    const body = provider.tokenize('x^2 + y^2 = z^2', clone)
    expect(body.tokens.map((token) => token.scopes)).toEqual(['string.other.math.typst'])
    const closing = provider.tokenize('$', body.endState)
    const after = provider.tokenize('#let y = 2', closing.endState)
    expect(after.tokens.map((token) => token.scopes)).toContain('keyword.other.typst')
    expect(after.tokens.map((token) => token.scopes)).not.toContain('string.other.math.typst')
    expect(provider.tokenize('#let y = 2', provider.getInitialState()).tokens).toEqual(after.tokens)
  })

  it.each([
    ['// Write /* to start a block comment.'],
    ['/* documentation: // */'],
    ['/* outer', '/* inner */ still outer', '*/'],
    ['$ "cost $5" + x $'],
    ['$ x + \\$ + y $'],
    ['$ "escaped \\" $5" + x $'],
    ['$ x + \\\\ $'],
    ['$', '"cost $5" + \\$ + y', '$'],
    ['$ x /* $ ignored */ + y $'],
    ['$', '// $ ignored', 'x + y', '$'],
    ['#let formula = $ "cost $5" + \\$ $']
  ])('returns to Typst code after a comment or math region (%j)', async (...lines) => {
    const provider = await createTextMateTokensProvider({ loadGrammar: loadTypstTextMateGrammar })
    let state = provider.getInitialState()
    for (const line of lines) {
      state = provider.tokenize(line, state).endState
    }
    const after = '#let after = 12pt'
    const tokens = provider.tokenize(after, state).tokens
    expect(tokens).toEqual(provider.tokenize(after, provider.getInitialState()).tokens)
    expect(tokens.map((token) => token.scopes)).toEqual(
      expect.arrayContaining(['keyword.other.typst', 'constant.numeric.length.typst'])
    )
  })

  it('keeps nested Typst block comments active until both closers', async () => {
    const provider = await createTextMateTokensProvider({ loadGrammar: loadTypstTextMateGrammar })
    let state = provider.tokenize('/* outer /* inner', provider.getInitialState()).endState
    state = provider.tokenize('*/ still outer', state).endState
    expect(provider.tokenize('#let hidden = 2', state).tokens.map((token) => token.scopes)).toEqual(
      ['comment.block.typst']
    )
  })

  it('converges to an equal state after an edit so Monaco stops re-tokenizing', async () => {
    const provider = await createTextMateTokensProvider({ loadGrammar: loadTypstTextMateGrammar })
    const stored = provider.tokenize('#let width = 12pt', provider.getInitialState()).endState
    const edited = provider.tokenize('#let width = 14pt', provider.getInitialState()).endState

    expect(edited).not.toBe(stored)
    expect(edited.equals(stored)).toBe(true)
    expect(provider.tokenize('$ x', provider.getInitialState()).endState.equals(stored)).toBe(false)
  })

  it.each([
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
