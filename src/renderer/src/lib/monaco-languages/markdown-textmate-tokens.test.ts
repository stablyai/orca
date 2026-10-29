import type * as Monaco from 'monaco-editor'
import { describe, expect, it, vi } from 'vitest'
import { loadNodeOniguruma } from '../syntax-highlighting/oniguruma-test-harness'
import { createMarkdownTokensProvider } from './markdown-textmate-tokens'

vi.mock('../syntax-highlighting/oniguruma', () => ({ loadOniguruma: loadNodeOniguruma }))

function tokenizeLines(provider: Monaco.languages.TokensProvider, lines: string[]): string[][] {
  let state = provider.getInitialState()
  return lines.map((line) => {
    const result = provider.tokenize(line, state)
    state = result.endState
    return result.tokens.map((token) => token.scopes)
  })
}

describe('createMarkdownTokensProvider', () => {
  it('styles markdown with Dark+ rules and highlights a fence once its grammar loads', async () => {
    const defineTheme = vi.fn()
    let replacement: Monaco.languages.TokensProvider | undefined
    const provider = await createMarkdownTokensProvider({
      editor: { defineTheme },
      languages: {
        setTokensProvider: (_language, next) => {
          if ('tokenize' in next && 'getInitialState' in next && !('tokenizeEncoded' in next)) {
            replacement = next
          }
          return { dispose: () => {} }
        }
      }
    })

    expect(defineTheme).toHaveBeenCalledWith(
      'vs-dark',
      expect.objectContaining({
        rules: expect.arrayContaining([
          { token: 'md.markup.heading', foreground: '#569cd6', fontStyle: 'bold' }
        ])
      })
    )
    const [heading, list] = tokenizeLines(provider, ['## Quick', '- **State:** open'])
    expect(new Set(heading)).toEqual(new Set(['md.markup.heading.markdown']))
    expect(list).toEqual([
      'md.punctuation.definition.list.begin.markdown',
      'md.text.html.markdown',
      'md.markup.bold.markdown',
      'md.markup.bold.markdown',
      'md.markup.bold.markdown',
      'md.text.html.markdown'
    ])

    const fence = ['```ts', 'const x = 1', '```']
    tokenizeLines(provider, fence)
    const refreshed = await vi.waitFor(() => {
      if (!replacement) {
        throw new Error('fence grammar has not loaded')
      }
      return replacement
    })
    expect(tokenizeLines(refreshed, ['```ts title="a.ts"', 'const x = 1', '```'])[1]).toContain(
      'md.storage.type.ts'
    )
  })
})
