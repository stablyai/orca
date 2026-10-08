// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { isEditableKeyboardTarget } from './browser-keyboard'

// Why: the old fakes passed a single joined selector to `closest`, so any
// `selector.includes(token)` check matched every token. Use the real DOM instead.
function targetInside(hostHtml: string): Element {
  const host = document.createElement('div')
  host.innerHTML = `${hostHtml}`
  document.body.appendChild(host)
  const leaf = host.querySelector('[data-target]')
  return leaf ?? host.firstElementChild!
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('isEditableKeyboardTarget', () => {
  it.each([
    ['input', '<input data-target />'],
    ['textarea', '<textarea data-target></textarea>'],
    ['select', '<select data-target></select>'],
    ['[contenteditable=""]', '<div contenteditable=""><span data-target></span></div>'],
    ['[contenteditable="true"]', '<div contenteditable="true"><span data-target></span></div>'],
    ['.monaco-editor', '<div class="monaco-editor"><span data-target></span></div>'],
    ['.diff-editor', '<div class="diff-editor"><span data-target></span></div>'],
    ['.rich-markdown-editor', '<div class="rich-markdown-editor"><span data-target></span></div>'],
    [
      '.rich-markdown-editor-shell',
      '<div class="rich-markdown-editor-shell"><span data-target></span></div>'
    ]
  ])('returns true for a target inside %s', (_token, html) => {
    expect(isEditableKeyboardTarget(targetInside(html))).toBe(true)
  })

  it('falls back to isContentEditable when no host selector matches', () => {
    expect(isEditableKeyboardTarget({ isContentEditable: true, closest: () => null })).toBe(true)
  })

  it('returns false for non-editable elements', () => {
    expect(isEditableKeyboardTarget(targetInside('<div data-target></div>'))).toBe(false)
    expect(isEditableKeyboardTarget({ isContentEditable: false, closest: () => null })).toBe(false)
  })

  it('returns false for a null target', () => {
    expect(isEditableKeyboardTarget(null)).toBe(false)
  })
})
