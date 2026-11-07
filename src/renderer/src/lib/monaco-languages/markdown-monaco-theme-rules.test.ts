import { describe, expect, it } from 'vitest'
import { pluginMonacoTokenRules } from '../plugin-monaco-token-rules'
import { loadBuiltInMarkdownRules, withBuiltInMarkdownRules } from './markdown-monaco-theme-rules'

async function markdownRules(
  base: 'light' | 'dark',
  colors: Record<string, string>,
  tokenColors: Parameters<typeof pluginMonacoTokenRules>[0]
) {
  const data = withBuiltInMarkdownRules(
    {
      base: base === 'dark' ? 'vs-dark' : 'vs',
      inherit: true,
      rules: pluginMonacoTokenRules(tokenColors, (value) => value),
      colors
    },
    await loadBuiltInMarkdownRules(base)
  )
  // Monaco applies rules in order, so the last one per token wins each setting.
  const byToken = new Map<string, { foreground?: string; fontStyle?: string }>()
  for (const { token, ...style } of data.rules) {
    byToken.set(token, { ...byToken.get(token), ...style })
  }
  return byToken
}

describe('withBuiltInMarkdownRules', () => {
  it("keeps the theme's markdown colors and fills the rest from Dark+", async () => {
    const rules = await markdownRules(
      'dark',
      { 'editor.background': '#0b0e14', 'editor.foreground': '#bfbdb6' },
      [
        { scope: 'markup.heading', settings: { foreground: '#aad94c', fontStyle: 'bold' } },
        { scope: 'entity.name', settings: { foreground: '#59c2ff' } },
        { scope: 'markup.quote', settings: { foreground: '#95e6cb', fontStyle: 'italic' } }
      ]
    )

    expect(rules.get('md.markup.heading')).toEqual({ foreground: '#aad94c', fontStyle: 'bold' })
    // Heading text takes the theme's `entity.name` color and its heading's bold.
    expect(rules.get('md.entity.name.section.markdown')).toEqual({
      foreground: '#59c2ff',
      fontStyle: 'bold'
    })
    expect(rules.get('md.markup.quote')).toEqual({ foreground: '#95e6cb', fontStyle: 'italic' })
    expect(rules.get('md.markup.inline.raw')).toEqual({ foreground: '#ce9178' })
    expect(rules.get('md.meta.embedded')).toEqual({ foreground: '#bfbdb6' })
  })

  it('colors heading text by a markup.heading descendant selector over plain entity.name', async () => {
    const rules = await markdownRules(
      'light',
      { 'editor.background': '#ffffff', 'editor.foreground': '#1f2328' },
      [
        { scope: 'entity.name', settings: { foreground: '#6f42c1' } },
        {
          scope: ['markup.heading', 'markup.heading entity.name'],
          settings: { foreground: '#005cc5', fontStyle: 'bold' }
        }
      ]
    )

    expect(rules.get('md.entity.name.section.markdown')).toEqual({
      foreground: '#005cc5',
      fontStyle: 'bold'
    })
  })

  it("paints Light+ plain text in the theme's foreground and drops unreadable fallbacks", async () => {
    const rules = await markdownRules(
      'light',
      { 'editor.background': '#d2d2d2', 'editor.foreground': '#442244' },
      []
    )

    expect(rules.get('md.meta.embedded')).toEqual({ foreground: '#442244' })
    // Light+ regexp groups (#d16969) are 2.3:1 on this background.
    expect(rules.get('md.punctuation.definition.group.regexp')).toBeUndefined()
    expect(rules.get('md.entity.name.section.markdown')).toEqual({
      foreground: '#800000',
      fontStyle: 'bold'
    })
  })
})
