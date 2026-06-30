import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma'
import type { IOnigLib, IRawGrammar } from 'vscode-textmate'
import { createTextMateTokensProvider, TEXTMATE_MAX_LINE_LENGTH } from './textmate-token-provider'

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

const testGrammar = {
  name: 'Test',
  scopeName: 'source.test',
  repository: {},
  patterns: [
    { match: '#.*$', name: 'comment.line.number-sign.test' },
    { match: '\\b(fn)\\b', name: 'keyword.control.test' },
    { match: '"(?:[^"\\\\]|\\\\.)*"', name: 'string.quoted.double.test' }
  ]
} as unknown as IRawGrammar

describe('createTextMateTokensProvider', () => {
  it('tokenizes with a TextMate grammar', async () => {
    const provider = await createTextMateTokensProvider({
      scopeName: 'source.test',
      loadGrammar: async (scopeName) => (scopeName === 'source.test' ? testGrammar : null),
      loadOniguruma: loadNodeOniguruma
    })

    const functionLine = provider.tokenize('fn greet = "hello"', provider.getInitialState())
    const functionScopes = functionLine.tokens.map((token) => token.scopes)
    expect(functionScopes).toContain('keyword.control.test')
    expect(functionScopes).toContain('string.quoted.double.test')

    const commentLine = provider.tokenize('# hello', provider.getInitialState())
    expect(commentLine.tokens.map((token) => token.scopes)).toContain(
      'comment.line.number-sign.test'
    )
  })

  it('skips TextMate tokenization for very long lines', async () => {
    const provider = await createTextMateTokensProvider({
      scopeName: 'source.test',
      loadGrammar: async (scopeName) => (scopeName === 'source.test' ? testGrammar : null),
      loadOniguruma: loadNodeOniguruma
    })

    expect(
      provider.tokenize('x'.repeat(TEXTMATE_MAX_LINE_LENGTH), provider.getInitialState())
    ).toMatchObject({
      tokens: [{ startIndex: 0, scopes: '' }]
    })
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
