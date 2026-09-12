import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma'
import type { IOnigLib, IRawGrammar } from 'vscode-textmate'
import nimGrammar from './textmate-grammars/nim.tmLanguage.json'
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

  it('fails clearly when a scope has no grammar', async () => {
    await expect(
      createTextMateTokensProvider({
        scopeName: 'source.unknown',
        loadGrammar: async () => null,
        loadOniguruma: loadNodeOniguruma
      })
    ).rejects.toThrow('No TextMate grammar registered for scope source.unknown')
  })
  it('reports a lazy regex failure once and keeps later lines usable as plain text', async () => {
    const onError = vi.fn()
    const provider = await createTextMateTokensProvider({
      scopeName: 'source.invalid',
      loadGrammar: async () => ({
        scopeName: 'source.invalid',
        repository: { $self: {}, $base: {} },
        patterns: [{ name: 'keyword', match: '[' }]
      }),
      loadOniguruma: loadNodeOniguruma,
      onError
    })
    const first = provider.tokenize('hello', provider.getInitialState())
    expect(first.tokens).toEqual([{ startIndex: 0, scopes: '' }])
    expect(provider.tokenize('next line', first.endState).tokens).toEqual(first.tokens)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)

    const valid = await createTextMateTokensProvider({
      scopeName: 'source.valid',
      loadGrammar: async () => ({
        scopeName: 'source.valid',
        repository: { $self: {}, $base: {} },
        patterns: [{ name: 'keyword', match: 'hello' }]
      }),
      loadOniguruma: loadNodeOniguruma,
      onError
    })
    expect(valid.tokenize('hello', valid.getInitialState()).tokens[0].scopes).toBe('keyword')
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
