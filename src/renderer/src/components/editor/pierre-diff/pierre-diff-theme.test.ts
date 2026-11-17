import { pluginMonacoTokenRules } from '@/lib/editor/appearance/plugin-monaco-token-rules'
import { expect, it } from 'vitest'
import { getResolvedOrResolveTheme } from '@pierre/diffs'
import { createHighlighter } from 'shiki'
import { resolvePierreDiffTheme } from './pierre-diff-theme'

it('highlights with the selected editor palette and token rules on the inherited base theme', async () => {
  const themes = resolvePierreDiffTheme({
    name: 'orca-diff-theme-port-test',
    data: {
      base: 'vs-dark',
      inherit: true,
      colors: { 'editor.background': '#102030', 'editor.foreground': '#eeeeee' },
      rules: pluginMonacoTokenRules(
        [{ scope: 'keyword', settings: { foreground: '#ff9999' } }],
        (color) => color
      )
    }
  })
  const theme = await getResolvedOrResolveTheme(themes.dark)
  expect(theme.bg).toBe('#102030')
  expect(theme.textmate).toBeDefined()
  const highlighter = await createHighlighter({
    themes: theme.textmate ? [theme.textmate] : [],
    langs: ['typescript']
  })
  try {
    const tokens = highlighter.codeToTokens('export const value = "hello"', {
      lang: 'typescript',
      theme: 'orca-diff-theme-port-test'
    })
    expect(tokens.tokens.flat().find((token) => token.content === 'export')?.color).toBe('#FF9999')
    expect(tokens.tokens.flat().find((token) => token.content.includes('hello'))?.color).toBe(
      '#CE9178'
    )
  } finally {
    highlighter.dispose()
  }
})
