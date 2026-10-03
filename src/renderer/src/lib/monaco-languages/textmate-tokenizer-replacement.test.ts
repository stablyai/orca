// @vitest-environment happy-dom
import type * as Monaco from 'monaco-editor'
import type * as MonacoEditorApi from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { registerTextMateLanguage as RegisterTextMateLanguage } from './textmate-language-registration'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type MonacoModule = typeof MonacoEditorApi

const TEXTMATE_TOKEN = 'textmate.marker.ruby'
const SNIPPET = 'def greet; end'

// Why: a fresh Monaco per test, since its tokenization registry is a module singleton.
async function loadMonacoWithMonarchRuby() {
  const monaco = await import('monaco-editor/esm/vs/editor/editor.api.js')
  // Why: the real basic-languages contribution registers Ruby's lazy Monarch tokenizer factory.
  await import('monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js')
  const { registerTextMateLanguage } = await import('./textmate-language-registration')
  return {
    monaco,
    registerStubTextMateRuby: () => registerStubTextMateRuby(monaco, registerTextMateLanguage)
  }
}

function registerStubTextMateRuby(
  monaco: MonacoModule,
  registerTextMateLanguage: typeof RegisterTextMateLanguage
): void {
  const state: Monaco.languages.IState = { clone: () => state, equals: () => true }
  const provider: Monaco.languages.TokensProvider = {
    getInitialState: () => state,
    tokenize: () => ({ tokens: [{ startIndex: 0, scopes: TEXTMATE_TOKEN }], endState: state })
  }
  registerTextMateLanguage(monaco, {
    language: { id: 'ruby' },
    scopeName: 'source.ruby',
    loadGrammar: vi.fn(),
    loadProviderModule: async () => ({ createTextMateTokensProvider: async () => provider }),
    replaceExistingTokenizer: true
  })
}

function firstTokenType(monaco: MonacoModule): string | undefined {
  return monaco.editor.tokenize(SNIPPET, 'ruby')[0]?.[0]?.type
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('TextMate tokenizer replacement for a Monarch basic language', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('keeps TextMate when the Monarch loader resolves after registration', async () => {
    const { monaco, registerStubTextMateRuby } = await loadMonacoWithMonarchRuby()
    // Why: start the Monarch factory and loader before TextMate registers, so they resolve afterwards.
    const monarchModule = import('monaco-editor/esm/vs/basic-languages/ruby/ruby.js')
    expect(firstTokenType(monaco)).toBe('')
    registerStubTextMateRuby()
    await monarchModule
    await settle()

    await vi.waitFor(() => expect(firstTokenType(monaco)).toBe(TEXTMATE_TOKEN))
    await settle()
    expect(firstTokenType(monaco)).toBe(TEXTMATE_TOKEN)
  })

  it('replaces a Monarch tokenizer that already resolved', async () => {
    const { monaco, registerStubTextMateRuby } = await loadMonacoWithMonarchRuby()
    await vi.waitFor(() => expect(firstTokenType(monaco)).toBe('keyword.def.ruby'))

    registerStubTextMateRuby()

    await vi.waitFor(() => expect(firstTokenType(monaco)).toBe(TEXTMATE_TOKEN))
  })
})
