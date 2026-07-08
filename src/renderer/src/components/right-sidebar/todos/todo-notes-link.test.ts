import { describe, it, expect } from 'vitest'
import { insertLinkScaffold, isLikelyUrl, wrapSelectionAsLink } from './todo-notes-link'

describe('isLikelyUrl', () => {
  it('accepts a single http(s) or www token', () => {
    expect(isLikelyUrl('https://example.com')).toBe(true)
    expect(isLikelyUrl('http://a.b/c?d=1#e')).toBe(true)
    expect(isLikelyUrl('  www.example.com ')).toBe(true)
  })

  it('rejects empty, prose, and multi-word text', () => {
    expect(isLikelyUrl('')).toBe(false)
    expect(isLikelyUrl('   ')).toBe(false)
    expect(isLikelyUrl('not a url')).toBe(false)
    expect(isLikelyUrl('see https://x.com')).toBe(false)
    expect(isLikelyUrl('example')).toBe(false)
  })
})

describe('wrapSelectionAsLink', () => {
  it('wraps the selection as [text](url) with the caret after the link', () => {
    const value = 'see docs here'
    const result = wrapSelectionAsLink(value, 4, 8, 'https://example.com')
    expect(result.text).toBe('see [docs](https://example.com) here')
    const caret = 'see [docs](https://example.com)'.length
    expect(result.selectionStart).toBe(caret)
    expect(result.selectionEnd).toBe(caret)
  })

  it('trims surrounding whitespace from the url', () => {
    const result = wrapSelectionAsLink('x', 0, 1, '  https://e.com  ')
    expect(result.text).toBe('[x](https://e.com)')
  })
})

describe('insertLinkScaffold', () => {
  it('uses the selection as the label and selects the url placeholder', () => {
    const result = insertLinkScaffold('click me', 0, 5)
    expect(result.text).toBe('[click](url) me')
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe('url')
  })

  it('falls back to a "text" label when there is no selection', () => {
    const result = insertLinkScaffold('', 0, 0)
    expect(result.text).toBe('[text](url)')
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe('url')
  })
})
