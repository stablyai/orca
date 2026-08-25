import { describe, expect, it } from 'vitest'
import {
  buildRemoteContextMenuExpression,
  getPositiveFiniteNumber,
  getRemoteBrowserMouseButton,
  readRemoteContextMenuResult,
  readRemoteCssViewportSize
} from './remote-browser-page-input-model'

describe('remote browser page input model', () => {
  it('maps mouse buttons and rejects unknown codes', () => {
    expect(getRemoteBrowserMouseButton(0)).toBe('left')
    expect(getRemoteBrowserMouseButton(1)).toBe('middle')
    expect(getRemoteBrowserMouseButton(2)).toBe('right')
    expect(getRemoteBrowserMouseButton(3)).toBeNull()
  })

  it('accepts only positive finite numbers', () => {
    expect(getPositiveFiniteNumber(12)).toBe(12)
    expect(getPositiveFiniteNumber(0)).toBeNull()
    expect(getPositiveFiniteNumber(-1)).toBeNull()
    expect(getPositiveFiniteNumber(Number.NaN)).toBeNull()
    expect(getPositiveFiniteNumber('12')).toBeNull()
  })

  it('embeds coordinates in the guest context-menu expression', () => {
    const expression = buildRemoteContextMenuExpression(10, 20)
    expect(expression).toContain('10')
    expect(expression).toContain('20')
    expect(expression).toContain('elementFromPoint')
  })

  it('parses context-menu eval results and rejects junk', () => {
    expect(readRemoteContextMenuResult(null)).toBeNull()
    expect(readRemoteContextMenuResult({ result: 1 })).toBeNull()
    expect(
      readRemoteContextMenuResult({
        result: JSON.stringify({
          linkUrl: 'https://example.com',
          pageUrl: 'https://example.com/page',
          selectionText: 'hi'
        })
      })
    ).toEqual({
      linkUrl: 'https://example.com',
      pageUrl: 'https://example.com/page',
      selectionText: 'hi'
    })
    expect(readRemoteContextMenuResult({ result: JSON.stringify({ linkUrl: '' }) })).toEqual({
      linkUrl: null,
      pageUrl: 'about:blank',
      selectionText: ''
    })
  })

  it('parses CSS viewport sizes from eval results', () => {
    expect(
      readRemoteCssViewportSize({ result: JSON.stringify({ width: 800, height: 600 }) })
    ).toEqual({ width: 800, height: 600 })
    expect(
      readRemoteCssViewportSize({ result: JSON.stringify({ width: 0, height: 600 }) })
    ).toBeNull()
    expect(readRemoteCssViewportSize({ result: 'not-json' })).toBeNull()
  })
})
