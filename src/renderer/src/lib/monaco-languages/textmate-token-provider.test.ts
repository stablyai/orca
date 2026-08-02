import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
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
})
