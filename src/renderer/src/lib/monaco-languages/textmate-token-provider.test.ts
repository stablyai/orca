import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma'
import type { IOnigLib, IRawGrammar } from 'vscode-textmate'
import gdscriptGrammar from './textmate-grammars/gdscript.tmLanguage.json'
import nimGrammar from './textmate-grammars/nim.tmLanguage.json'
import { createTextMateTokensProvider, toMonacoThemeTokenScope } from './textmate-token-provider'

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
    expect(procScopes).toContain('type')
    expect(procScopes).toContain('keyword')

    const commentLine = provider.tokenize('# hello', provider.getInitialState())
    expect(commentLine.tokens.map((token) => token.scopes)).toContain(
      'comment.line.number-sign.nim'
    )
  })

  it('tokenizes GDScript with the vendored TextMate grammar', async () => {
    const provider = await createTextMateTokensProvider({
      scopeName: 'source.gdscript',
      loadGrammar: async (scopeName) =>
        scopeName === 'source.gdscript' ? (gdscriptGrammar as unknown as IRawGrammar) : null,
      loadOniguruma: loadNodeOniguruma
    })

    const declaration = provider.tokenize(
      'func greet(name: String) -> void:',
      provider.getInitialState()
    )
    const declarationScopes = declaration.tokens.map((token) => token.scopes)
    expect(declarationScopes).toContain('annotation')
    expect(declarationScopes).toContain('keyword.flow')
    expect(declarationScopes).toContain('type')

    const comment = provider.tokenize('# hello', provider.getInitialState())
    expect(comment.tokens.map((token) => token.scopes)).toContain(
      'comment.line.number-sign.gdscript'
    )
  })

  it('recognizes Godot declarations and return types', async () => {
    const provider = await createTextMateTokensProvider({
      scopeName: 'source.gdscript',
      loadGrammar: async (scopeName) =>
        scopeName === 'source.gdscript' ? (gdscriptGrammar as unknown as IRawGrammar) : null,
      loadOniguruma: loadNodeOniguruma
    })
    const initialState = provider.getInitialState()

    const readyScopes = provider
      .tokenize('@onready var player: Node2D = $Player', initialState)
      .tokens.map((token) => token.scopes)
    expect(readyScopes).toContain('keyword.flow')

    const constantScopes = provider
      .tokenize('const MAX_SPEED := 400.0', initialState)
      .tokens.map((token) => token.scopes)
    expect(constantScopes).toContain('variable')

    const functionScopes = provider
      .tokenize('func move(delta: float) -> bool:', initialState)
      .tokens.map((token) => token.scopes)
    expect(functionScopes).toContain('type')
  })

  it('maps TextMate-only namespaces to Monaco theme categories', () => {
    expect(toMonacoThemeTokenScope('entity.name.function.gdscript')).toBe('keyword.flow')
    expect(toMonacoThemeTokenScope('entity.name.function.nim')).toBe('type')
    expect(toMonacoThemeTokenScope('entity.name.function.decorator.gdscript')).toBe('keyword.flow')
    expect(toMonacoThemeTokenScope('storage.type.const.gdscript')).toBe('annotation')
    expect(toMonacoThemeTokenScope('keyword.operator.assignment.gdscript')).toBe('delimiter')
    expect(toMonacoThemeTokenScope('variable.other.constant.gdscript')).toBe('variable')
    expect(toMonacoThemeTokenScope('variable.other.property.gdscript')).toBe('identifier')
    expect(toMonacoThemeTokenScope('constant.numeric.float.gdscript')).toBe('number')
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
