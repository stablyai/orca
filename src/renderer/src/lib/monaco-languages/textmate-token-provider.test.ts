import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma'
import type { IOnigLib, IRawGrammar } from 'vscode-textmate'
import nimGrammar from './textmate-grammars/nim.tmLanguage.json'
import { loadRubyTextMateGrammar } from './register-ruby'
import { loadTypstTextMateGrammar } from './register-typst'
import { createTextMateTokensProvider } from './textmate-token-provider'

const require = createRequire(import.meta.url)

let nodeOnigurumaPromise: Promise<IOnigLib> | undefined

async function loadNodeOniguruma(): Promise<IOnigLib> {
  nodeOnigurumaPromise ??= (async () => {
    const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm')
    const wasmBytes = await readFile(wasmPath)
    const wasmBuffer = wasmBytes.buffer.slice(
      wasmBytes.byteOffset,
      wasmBytes.byteOffset + wasmBytes.byteLength
    )
    await loadWASM(wasmBuffer)
    return { createOnigScanner, createOnigString }
  })()

  return nodeOnigurumaPromise
}

describe('createTextMateTokensProvider', () => {
  it('tokenizes Nim with the vendored TextMate grammar', async () => {
    const provider = await createTextMateTokensProvider({
      scopeName: 'source.nim',
      loadGrammar: async (scopeName) =>
        scopeName === 'source.nim' ? (nimGrammar as unknown as IRawGrammar) : null,
      loadOniguruma: loadNodeOniguruma
    })

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
    const provider = await createTextMateTokensProvider({
      scopeName: 'source.typst',
      loadGrammar: loadTypstTextMateGrammar,
      loadOniguruma: loadNodeOniguruma
    })
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
    const provider = await createTextMateTokensProvider({
      scopeName: 'source.typst',
      loadGrammar: loadTypstTextMateGrammar,
      loadOniguruma: loadNodeOniguruma
    })

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
    const provider = await createTextMateTokensProvider({
      scopeName: 'source.typst',
      loadGrammar: loadTypstTextMateGrammar,
      loadOniguruma: loadNodeOniguruma
    })
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
    const provider = await createTextMateTokensProvider({
      scopeName: 'source.typst',
      loadGrammar: loadTypstTextMateGrammar,
      loadOniguruma: loadNodeOniguruma
    })
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
    const provider = await createTextMateTokensProvider({
      scopeName: 'source.typst',
      loadGrammar: loadTypstTextMateGrammar,
      loadOniguruma: loadNodeOniguruma
    })
    let state = provider.tokenize('/* outer /* inner', provider.getInitialState()).endState
    state = provider.tokenize('*/ still outer', state).endState
    expect(provider.tokenize('#let hidden = 2', state).tokens.map((token) => token.scopes)).toEqual(
      ['comment.block.typst']
    )
  })

  it('tokenizes Ruby with the vendored VS Code grammar', async () => {
    const provider = await createTextMateTokensProvider({
      scopeName: 'source.ruby',
      loadGrammar: loadRubyTextMateGrammar,
      loadOniguruma: loadNodeOniguruma
    })
    let state = provider.getInitialState()
    const tokensOf = (line: string) => {
      const result = provider.tokenize(line, state)
      state = result.endState
      return result.tokens.map((token, index) => ({
        text: line.slice(token.startIndex, result.tokens[index + 1]?.startIndex),
        scope: token.scopes
      }))
    }

    expect(tokensOf('  def greet(name)')).toEqual(
      expect.arrayContaining([
        { text: 'def', scope: 'keyword.control.def.ruby' },
        { text: 'greet', scope: 'entity.name.function.ruby' }
      ])
    )
    expect(tokensOf('    @count = :ready')).toEqual(
      expect.arrayContaining([
        { text: 'count', scope: 'variable.other.readwrite.instance.ruby' },
        { text: 'ready', scope: 'constant.language.symbol.ruby' }
      ])
    )
    expect(tokensOf('    puts "Hi #{name}"')).toEqual(
      expect.arrayContaining([
        { text: '#{', scope: 'punctuation.section.embedded.begin.ruby' },
        { text: 'name', scope: 'source.ruby' },
        { text: '}', scope: 'punctuation.section.embedded.end.ruby' }
      ])
    )
    expect(tokensOf('    text = <<~TEXT')).toContainEqual({
      text: '<<~TEXT',
      scope: 'string.definition.begin.ruby'
    })
    expect(tokensOf('      Hello')).toEqual([
      { text: '      Hello', scope: 'string.unquoted.heredoc.ruby' }
    ])
    expect(tokensOf('    TEXT')).toEqual([
      { text: '    TEXT', scope: 'string.definition.end.ruby' }
    ])
    expect(tokensOf('  end')).toContainEqual({ text: 'end', scope: 'keyword.control.ruby' })
  })

  it('keeps tokenizing Ruby heredocs that embed unvendored grammars', async () => {
    const provider = await createTextMateTokensProvider({
      scopeName: 'source.ruby',
      loadGrammar: loadRubyTextMateGrammar,
      loadOniguruma: loadNodeOniguruma
    })
    const lines = [
      'sql = <<~SQL',
      '  SELECT * FROM users',
      'SQL',
      'html = <<~HTML',
      '  <p>hi</p>',
      'HTML'
    ]
    let state = provider.getInitialState()
    const lineTokens = lines.map((line) => {
      const result = provider.tokenize(line, state)
      state = result.endState
      return result.tokens
    })

    expect(lineTokens.every((tokens) => tokens.length > 0)).toBe(true)
    expect(lineTokens[1]).toEqual([{ startIndex: 0, scopes: 'source.sql' }])
    expect(lineTokens[2].map((token) => token.scopes)).toEqual(['string.definition.end.ruby'])
    expect(provider.tokenize('x = 1', state).tokens.map((token) => token.scopes)).toContain(
      'constant.numeric.ruby'
    )
  })

  it('fails clearly when a scope has no grammar', async () => {
    await expect(
      createTextMateTokensProvider({
        scopeName: 'source.unknown',
        loadGrammar: async () => null,
        loadOniguruma: loadNodeOniguruma
      })
    ).rejects.toThrow('No TextMate grammar registered for scope source.unknown')
  })
})
