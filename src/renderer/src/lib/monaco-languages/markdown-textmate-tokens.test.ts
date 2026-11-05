import type * as Monaco from 'monaco-editor'
import { TokenMetadata } from 'monaco-editor/esm/vs/editor/common/encodedTokenAttributes.js'
import { TokenTheme } from 'monaco-editor/esm/vs/editor/common/languages/supports/tokenization.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginThemeTokenColorRule } from '../../../../shared/plugins/artifacts/plugin-theme-artifact'
import { useCodeEditorThemeStore } from '@/store/code-editor-theme'
import { derivePluginMonacoTheme } from '../plugin-monaco-theme'
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

const noopMonaco = {
  editor: { defineTheme: () => {} },
  languages: { setTokensProvider: () => ({ dispose: () => {} }) }
}

function pluginTheme(
  base: 'light' | 'dark',
  surface: string,
  foreground: string,
  tokenColors: PluginThemeTokenColorRule[]
) {
  const theme = derivePluginMonacoTheme({
    base,
    read: (token) => ({ '--editor-surface': surface, '--foreground': foreground })[token] ?? '',
    painted: {},
    probe: (value) => {
      const [r, g, b] = (value.match(/[0-9a-f]{2}/gi) ?? []).map((pair) =>
        Number.parseInt(pair, 16)
      )
      return [r, g, b, 1]
    },
    tokenColors
  })
  if (!theme) {
    throw new Error('the contrast gate rejected the test theme')
  }
  return theme
}

/** How Monaco itself paints `text` in `line`, through the active theme's rules. */
function paint(provider: Monaco.languages.TokensProvider, line: string, text: string) {
  const { monaco } = useCodeEditorThemeStore.getState()
  const tokenTheme = TokenTheme.createFromRawTokenTheme(
    [
      {
        token: '',
        foreground: monaco?.data.colors['editor.foreground'],
        background: monaco?.data.colors['editor.background']
      },
      ...(monaco?.data.rules ?? [])
    ],
    []
  )
  const { tokens } = provider.tokenize(line, provider.getInitialState())
  const token = tokens.findLast(({ startIndex }) => startIndex <= line.indexOf(text))
  const metadata = tokenTheme.match(1, token?.scopes ?? '')
  return {
    color: tokenTheme.getColorMap()[TokenMetadata.getForeground(metadata)].toString(),
    bold: (TokenMetadata.getFontStyle(metadata) & 2) !== 0
  }
}

afterEach(() => {
  useCodeEditorThemeStore.setState({ monaco: null, override: null })
})

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

  it('paints markdown with the stock colors of a theme that has no markup scopes', async () => {
    useCodeEditorThemeStore.setState({
      monaco: pluginTheme('dark', '#1b1430', '#e8e0ff', [
        { scope: 'keyword', settings: { foreground: '#ff7ad9' } }
      ])
    })
    const provider = await createMarkdownTokensProvider(noopMonaco)

    expect(paint(provider, '# Title', 'Title')).toEqual({ color: '#569cd6', bold: true })
  })

  it('paints a theme that arrives after the tokenizer over the stock colors', async () => {
    const provider = await createMarkdownTokensProvider(noopMonaco)
    useCodeEditorThemeStore.setState({
      monaco: pluginTheme('dark', '#1b1430', '#e8e0ff', [
        { scope: 'markup.heading', settings: { foreground: '#ff7ad9' } },
        // Broader than the stock `markup.bold`, and still the theme's choice.
        { scope: 'markup', settings: { foreground: '#7ad9ff' } },
        // No stock rule styles quotes, so only the theme can color them.
        { scope: 'markup.quote', settings: { foreground: '#aaffaa' } }
      ])
    })

    expect(paint(provider, '# Title', 'Title')).toEqual({ color: '#ff7ad9', bold: true })
    expect(paint(provider, '**strong**', 'strong')).toEqual({ color: '#7ad9ff', bold: true })
    expect(paint(provider, '> quoted', 'quoted').color).toBe('#aaffaa')

    useCodeEditorThemeStore.setState({ monaco: null })
    expect(tokenizeLines(provider, ['> quoted'])[0]).not.toContain('md.markup.quote.markdown')
  })

  it('paints heading text from a descendant selector over a broader inner one', async () => {
    useCodeEditorThemeStore.setState({
      monaco: pluginTheme('light', '#ffffff', '#1f2328', [
        { scope: 'entity.name', settings: { foreground: '#6f42c1' } },
        {
          scope: ['markup.heading', 'markup.heading entity.name'],
          settings: { foreground: '#005cc5', fontStyle: 'bold' }
        }
      ])
    })
    const provider = await createMarkdownTokensProvider(noopMonaco)

    expect(paint(provider, '# Title', 'Title')).toEqual({ color: '#005cc5', bold: true })
  })

  it('keeps the heading style on text a theme colors by its inner scope', async () => {
    useCodeEditorThemeStore.setState({
      monaco: pluginTheme('dark', '#191724', '#e0def4', [
        { scope: 'entity.name.section', settings: { foreground: '#9ccfd8' } },
        { scope: 'markup.heading', settings: { fontStyle: 'bold' } }
      ])
    })
    const provider = await createMarkdownTokensProvider(noopMonaco)

    expect(paint(provider, '# Title', 'Title')).toEqual({ color: '#9ccfd8', bold: true })
  })

  it('drops stock and theme colors that would be unreadable on the editor', async () => {
    useCodeEditorThemeStore.setState({
      monaco: pluginTheme('light', '#d1d1d1', '#000000', [
        { scope: 'markup.heading', settings: { foreground: '#cccccc' } }
      ])
    })
    const provider = await createMarkdownTokensProvider(noopMonaco)

    // Light+ escapes are `#ee0000`, under 3:1 here, so they inherit the readable `constant.character`.
    expect(paint(provider, 'a \\* b', '\\*').color).toBe('#0000ff')
    // The theme's heading color is unreadable, so Light+ `#800000` stays.
    expect(paint(provider, '# Title', 'Title').color).toBe('#800000')
  })
})
