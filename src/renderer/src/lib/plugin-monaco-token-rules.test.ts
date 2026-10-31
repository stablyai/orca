import { describe, expect, it } from 'vitest'
import { pluginMonacoTokenRules } from './plugin-monaco-token-rules'

const rules = (tokenColors: Parameters<typeof pluginMonacoTokenRules>[0]) =>
  Object.fromEntries(
    pluginMonacoTokenRules(tokenColors, (value) => (value === '#000000' ? null : value)).map(
      ({ token, ...style }) => [token, style]
    )
  )

describe('pluginMonacoTokenRules', () => {
  it('colors Monaco token names by the TextMate scope a VS Code theme would use', () => {
    const result = rules([
      { scope: 'comment', settings: { foreground: '#7a7a7a', fontStyle: 'italic' } },
      { scope: ['keyword', 'storage'], settings: { foreground: '#ff79c6' } },
      { scope: 'constant.numeric, constant.language', settings: { foreground: '#bd93f9' } },
      { scope: 'entity.name.function', settings: { foreground: '#50fa7b' } },
      { scope: 'markup.heading', settings: { foreground: '#8be9fd', fontStyle: 'bold' } }
    ])
    expect(result.comment).toEqual({ foreground: '#7a7a7a', fontStyle: 'italic' })
    expect(result.number).toEqual({ foreground: '#bd93f9' })
    // A parent scope covers its children, and Monaco's JSON keywords are TextMate constants.
    expect(result['keyword.flow']).toEqual({ foreground: '#ff79c6' })
    expect(result['keyword.json']).toEqual({ foreground: '#bd93f9' })
    expect(result.function).toEqual({ foreground: '#50fa7b' })
    expect(result['keyword.md']).toEqual({ foreground: '#8be9fd', fontStyle: 'bold' })
    expect(result['keyword.heading']).toEqual({ foreground: '#8be9fd', fontStyle: 'bold' })
    // Raw selectors serve vendored TextMate grammars, which emit scopes as Monaco tokens.
    expect(result['constant.numeric']).toEqual({ foreground: '#bd93f9' })
    expect(result).not.toHaveProperty('type')
  })

  it('prefers the most specific selector, then the later rule, per setting', () => {
    const result = rules([
      { scope: 'string', settings: { foreground: '#111111', fontStyle: 'italic' } },
      { scope: 'string.regexp', settings: { foreground: '#222222' } },
      { scope: 'string', settings: { foreground: '#333333' } }
    ])
    expect(result.string).toEqual({ foreground: '#333333', fontStyle: 'italic' })
    expect(result.regexp).toEqual({ foreground: '#222222', fontStyle: 'italic' })
  })

  it('falls back to the parent token when its own scope is unset', () => {
    expect(
      rules([{ scope: 'string', settings: { foreground: '#aa5500' } }])['string.key.json']
    ).toEqual({
      foreground: '#aa5500'
    })
  })

  it('skips descendant selectors and colors the caller refuses', () => {
    const result = rules([
      { scope: 'meta.embedded string', settings: { foreground: '#aa5500' } },
      { scope: 'comment', settings: { foreground: '#000000' } }
    ])
    expect(result).toEqual({})
  })
})
