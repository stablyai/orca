import { describe, expect, it } from 'vitest'
import {
  buildRemoteContextMenuExpression,
  getPositiveFiniteNumber,
  getRemoteBrowserMouseButton,
  hasRemoteBrowserClickModifier,
  isSimpleRemoteBrowserClick,
  readRemoteContextMenuResult,
  readRemoteCssViewportSize,
  type RemoteBrowserPressState
} from './remote-browser-page-input-model'

const press: RemoteBrowserPressState = {
  environmentId: 'env-1',
  pageId: 'page-1',
  button: 'left',
  point: { x: 100, y: 100 },
  modified: false
}

describe('remote browser page input model', () => {
  it('maps mouse buttons and rejects unknown codes', () => {
    expect(getRemoteBrowserMouseButton(0)).toBe('left')
    expect(getRemoteBrowserMouseButton(1)).toBe('middle')
    expect(getRemoteBrowserMouseButton(2)).toBe('right')
    expect(getRemoteBrowserMouseButton(3)).toBeNull()
  })

  it('treats only jitter-sized, unmodified, same-target pairs as a simple click', () => {
    expect(isSimpleRemoteBrowserClick(press, { ...press, point: { x: 102, y: 102 } })).toBe(true)
    expect(isSimpleRemoteBrowserClick(press, { ...press, point: { x: 108, y: 100 } })).toBe(false)
    expect(isSimpleRemoteBrowserClick(press, { ...press, button: 'middle' })).toBe(false)
    expect(isSimpleRemoteBrowserClick(press, { ...press, modified: true })).toBe(false)
    expect(isSimpleRemoteBrowserClick({ ...press, modified: true }, press)).toBe(false)
    expect(isSimpleRemoteBrowserClick(press, { ...press, pageId: 'page-2' })).toBe(false)
    expect(isSimpleRemoteBrowserClick(press, { ...press, environmentId: 'env-2' })).toBe(false)
  })

  it('reads any held modifier as semantics-changing', () => {
    const plain = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
    expect(hasRemoteBrowserClickModifier(plain)).toBe(false)
    expect(hasRemoteBrowserClickModifier({ ...plain, metaKey: true })).toBe(true)
    expect(hasRemoteBrowserClickModifier({ ...plain, ctrlKey: true })).toBe(true)
    expect(hasRemoteBrowserClickModifier({ ...plain, altKey: true })).toBe(true)
    expect(hasRemoteBrowserClickModifier({ ...plain, shiftKey: true })).toBe(true)
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
