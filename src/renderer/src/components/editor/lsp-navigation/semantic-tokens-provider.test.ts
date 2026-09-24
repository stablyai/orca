// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import { installLanguageServerSemanticTokensProvider } from './semantic-tokens-provider'
import {
  SEMANTIC_TOKEN_RENDERER_TYPES,
  SEMANTIC_TOKEN_RENDERER_MODIFIERS
} from './semantic-tokens-reencode'

type CapturedProvider = {
  getLegend: () => unknown
  provideDocumentSemanticTokens: (
    model: unknown,
    lastResultId: string | null,
    token: unknown
  ) => Promise<unknown>
  releaseDocumentSemanticTokens: (resultId: string | undefined) => void
}

type ThemeRule = { token: string; foreground?: string }
type ThemeOpts = { base: string; rules: ThemeRule[] }

function installAndCapture(): {
  captured: CapturedProvider[]
  defineThemeCalls: { name: string; opts: ThemeOpts }[]
} {
  const captured: CapturedProvider[] = []
  const defineThemeCalls: { name: string; opts: ThemeOpts }[] = []
  const monaco = {
    languages: {
      registerDocumentSemanticTokensProvider: (_selector: unknown, provider: CapturedProvider) => {
        captured.push(provider)
        return { dispose: () => {} }
      }
    },
    editor: {
      defineTheme: (name: string, opts: ThemeOpts) => {
        defineThemeCalls.push({ name, opts })
      }
    }
  } as unknown as typeof Monaco
  installLanguageServerSemanticTokensProvider(monaco)
  return { captured, defineThemeCalls }
}

function setApi(semanticTokens: (args: { filePath: string }) => Promise<unknown>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      languageServers: { semanticTokens }
    }
  })
}

function makeModel(fsPath: string): unknown {
  return {
    uri: { scheme: 'file', fsPath }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('semantic-tokens provider — getLegend must be a METHOD (shape trap, S5)', () => {
  it('exposes getLegend as a function, not a property (the silent no-color trap)', () => {
    // spike findings §1: monaco's IDocumentSemanticTokensProvider requires
    // getLegend() to be a METHOD. A `legend` property makes fetch happen but
    // the consumer throws `getLegend is not a function` (swallowed by pageerror)
    // -> sparse store stays empty -> everything looks fine but no color.
    const { captured } = installAndCapture()
    expect(captured).toHaveLength(1)
    expect(typeof captured[0]?.getLegend).toBe('function')

    const legend = captured[0]?.getLegend() as { tokenTypes: string[]; tokenModifiers: string[] }
    expect(legend.tokenTypes).toEqual([...SEMANTIC_TOKEN_RENDERER_TYPES])
    expect(legend.tokenModifiers).toEqual([...SEMANTIC_TOKEN_RENDERER_MODIFIERS])
  })
})

describe('semantic-tokens provider — provideDocumentSemanticTokens', () => {
  it('calls the IPC semanticTokens and returns a Uint32Array re-encoded by name', async () => {
    let calledArgs: { filePath: string } | null = null
    setApi(async (args: { filePath: string }) => {
      calledArgs = args
      return {
        ok: true,
        tokens: {
          tokenTypes: ['function', 'variable'],
          tokenModifiers: ['declaration'],
          tokens: [
            { line: 0, char: 0, length: 4, type: 'function', modifiers: ['declaration'] },
            { line: 0, char: 8, length: 5, type: 'variable', modifiers: [] }
          ]
        }
      }
    })
    const { captured } = installAndCapture()
    const model = makeModel('D:\\repo\\a.cpp')

    const result = (await captured[0]?.provideDocumentSemanticTokens(model, null, {})) as {
      data: Uint32Array
    }

    expect(calledArgs).toEqual({ filePath: 'D:\\repo\\a.cpp' })
    expect(result).toBeDefined()
    expect(result.data).toBeInstanceOf(Uint32Array)
    expect(result.data.length).toBe(10) // 2 tokens * 5
  })

  it('returns an empty result when the server has no legend (empty token set)', async () => {
    setApi(async () => ({
      ok: true,
      tokens: { tokenTypes: [], tokenModifiers: [], tokens: [] }
    }))
    const { captured } = installAndCapture()
    const result = (await captured[0]?.provideDocumentSemanticTokens(
      makeModel('D:\\repo\\a.cpp'),
      null,
      {}
    )) as { data: Uint32Array }
    expect(result.data).toBeInstanceOf(Uint32Array)
    expect(result.data.length).toBe(0)
  })

  it('returns an empty result when IPC fails (degrades to lexical color)', async () => {
    setApi(async () => ({ ok: false, error: 'no session', tokens: null }))
    const { captured } = installAndCapture()
    const result = (await captured[0]?.provideDocumentSemanticTokens(
      makeModel('D:\\repo\\a.cpp'),
      null,
      {}
    )) as { data: Uint32Array }
    expect(result.data.length).toBe(0)
  })

  it('returns null (no fetch) for a non-file model', async () => {
    let calls = 0
    setApi(async () => {
      calls += 1
      return { ok: true, tokens: { tokenTypes: [], tokenModifiers: [], tokens: [] } }
    })
    const { captured } = installAndCapture()
    const result = await captured[0]?.provideDocumentSemanticTokens(
      { uri: { scheme: 'inmemory', fsPath: '' } },
      null,
      {}
    )
    expect(result).toBeNull()
    expect(calls).toBe(0)
  })
})

describe('semantic-tokens provider — releaseDocumentSemanticTokens', () => {
  it('is a no-op (monaco requires the method but clangd full-only needs no release)', () => {
    const { captured } = installAndCapture()
    expect(() => captured[0]?.releaseDocumentSemanticTokens('id-1')).not.toThrow()
  })
})

describe('semantic-tokens provider — theme defineTheme', () => {
  it('defines the orca-lsp-dark theme on the VS Code Dark+ approx colors (5 identifier classes)', () => {
    const { defineThemeCalls } = installAndCapture()
    expect(defineThemeCalls).toHaveLength(1)
    const call = defineThemeCalls[0] ?? { name: '', opts: { base: '', rules: [] } }
    expect(call.name).toBe('orca-lsp-dark')
    expect(call.opts.base).toBe('vs-dark')
    const byToken = new Map(call.opts.rules.map((r) => [r.token, r.foreground]))
    // spike findings §1 VS Code Dark+ approximations:
    expect(byToken.get('function')).toBe('dcdcaa')
    expect(byToken.get('type')).toBe('4ec9b0')
    expect(byToken.get('variable')).toBe('9cdcfe')
    expect(byToken.get('macro')).toBe('c586c0')
    expect(byToken.get('enumMember')).toBe('4fc1ff')
  })
})
