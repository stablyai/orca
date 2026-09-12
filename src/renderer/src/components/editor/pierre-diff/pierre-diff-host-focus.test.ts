// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { isActiveElementInsideHost, shouldFocusPierreDiffHost } from './pierre-diff-host-focus'

function clickPath(...nodes: EventTarget[]): Pick<Event, 'composedPath'> {
  return { composedPath: () => nodes }
}

describe('isActiveElementInsideHost', () => {
  it('treats the host and light-DOM descendants as inside', () => {
    const host = document.createElement('div')
    const input = document.createElement('input')
    host.append(input)
    expect(isActiveElementInsideHost(host, host)).toBe(true)
    expect(isActiveElementInsideHost(host, input)).toBe(true)
    expect(isActiveElementInsideHost(host, document.createElement('div'))).toBe(false)
  })

  it('walks open shadow trees to the light-DOM host', () => {
    const host = document.createElement('div')
    const diffs = document.createElement('diffs-container')
    host.append(diffs)
    const shadow = diffs.attachShadow({ mode: 'open' })
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    shadow.append(editor)
    expect(isActiveElementInsideHost(host, editor)).toBe(true)
  })
})

describe('shouldFocusPierreDiffHost', () => {
  it('focuses the host for a read-only click while body has focus', () => {
    const host = document.createElement('div')
    const code = document.createElement('span')
    host.append(code)
    expect(shouldFocusPierreDiffHost(host, document.body, clickPath(code, host))).toBe(true)
  })

  it('does not steal focus from a contenteditable inside Pierre shadow', () => {
    const host = document.createElement('div')
    const diffs = document.createElement('diffs-container')
    host.append(diffs)
    const shadow = diffs.attachShadow({ mode: 'open' })
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    const glyph = document.createElement('span')
    editor.append(glyph)
    shadow.append(editor)
    expect(
      shouldFocusPierreDiffHost(host, document.body, clickPath(glyph, editor, diffs, host))
    ).toBe(false)
    expect(shouldFocusPierreDiffHost(host, editor, clickPath(glyph, editor, diffs, host))).toBe(
      false
    )
  })

  it('does not steal focus from the in-surface find input', () => {
    const host = document.createElement('div')
    const input = document.createElement('input')
    host.append(input)
    expect(shouldFocusPierreDiffHost(host, document.body, clickPath(input, host))).toBe(false)
    expect(shouldFocusPierreDiffHost(host, input, clickPath(input, host))).toBe(false)
  })
})
