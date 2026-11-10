import { describe, expect, it } from 'vitest'
import { pluginMonacoTokenRules } from './plugin-monaco-token-rules'

const rules = (tokenColors: Parameters<typeof pluginMonacoTokenRules>[0]) =>
  Object.fromEntries(
    pluginMonacoTokenRules(tokenColors, (value) => (value === '#000000' ? null : value)).map(
      ({ token, ...style }) => [token, style]
    )
  )

describe('pluginMonacoTokenRules', () => {
  it('prefers the most specific selector, then the later rule, per setting', () => {
    const result = rules([
      { scope: 'string', settings: { foreground: '#111111', fontStyle: 'italic' } },
      { scope: 'string.regexp', settings: { foreground: '#222222' } },
      { scope: 'string', settings: { foreground: '#333333' } }
    ])
    expect(result.string).toEqual({ foreground: '#333333', fontStyle: 'italic' })
    expect(result.regexp).toEqual({ foreground: '#222222', fontStyle: 'italic' })
  })
})
