import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma'
import type { IOnigLib, IRawGrammar } from 'vscode-textmate'
import nimGrammar from './textmate-grammars/nim.tmLanguage.json'
import { loadCudaTextMateGrammar } from './register-cuda'
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

  // Why: register-cuda.test.ts only asserts loadCudaTextMateGrammar returns the
  // right object per scope. Tokenizing through the real registry here pins the
  // "include": "source.cpp" fallback that loader wires up — if that stopped
  // resolving, most of a .cu file would silently lose highlighting.
  it('tokenizes CUDA qualifiers, built-ins, and kernel launches, falling back to C++ for comments', async () => {
    const provider = await createTextMateTokensProvider({
      scopeName: 'source.cuda-cpp',
      loadGrammar: loadCudaTextMateGrammar,
      loadOniguruma: loadNodeOniguruma
    })

    let state = provider.getInitialState()
    const qualifierLine = provider.tokenize('__global__ void kernel(int *a) {', state)
    state = qualifierLine.endState
    expect(qualifierLine.tokens.map((token) => token.scopes)).toContain(
      'keyword.function.qualifier.cuda-cpp'
    )

    const builtinLine = provider.tokenize('  int i = blockIdx.x;', state)
    state = builtinLine.endState
    expect(builtinLine.tokens.map((token) => token.scopes)).toContain('variable.language.cuda-cpp')

    const launchLine = provider.tokenize('kernel<<<grid, block>>>(a);', state)
    state = launchLine.endState
    expect(launchLine.tokens.map((token) => token.scopes)).toContain('meta.kernel-call.cuda-cpp')

    const commentLine = provider.tokenize('// fallback comment', state)
    expect(commentLine.tokens.map((token) => token.scopes)).toContain(
      'comment.line.double-slash.cpp'
    )
  })
})
