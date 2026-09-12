// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  hasHostTextSelection,
  isEditableKeyboardTarget,
  isNativeCopyChord
} from './browser-keyboard'

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

  it('queries every editable host in one selector', () => {
    const closest = vi.fn((_selector: string) => null)
    isEditableKeyboardTarget({ isContentEditable: false, closest })

    const selector = closest.mock.calls[0][0]
    const tokens = selector.split(',').map((part) => part.trim())
    expect(tokens).toEqual([
      'input',
      'textarea',
      'select',
      '[contenteditable=""]',
      '[contenteditable="true"]',
      '.monaco-editor',
      '.diff-editor',
      '.rich-markdown-editor',
      '.rich-markdown-editor-shell'
    ])
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

describe('hasHostTextSelection', () => {
  it('returns true for a non-collapsed selection with text', () => {
    expect(hasHostTextSelection({ isCollapsed: false, toString: () => 'copied prose' })).toBe(true)
  })

  it('returns false for a collapsed caret', () => {
    expect(hasHostTextSelection({ isCollapsed: true, toString: () => '' })).toBe(false)
  })

  // Why: a range can span layout whitespace between elements without selecting any text the user
  // would recognize as copied, and suppressing the shortcut for that would look like a dead key.
  it('returns false for a whitespace-only selection', () => {
    expect(hasHostTextSelection({ isCollapsed: false, toString: () => '  \n ' })).toBe(false)
  })

  it('returns false when there is no selection', () => {
    expect(hasHostTextSelection(null)).toBe(false)
  })

  it('reads the live document selection by default', () => {
    const host = document.createElement('p')
    host.textContent = 'assistant reply'
    document.body.appendChild(host)
    const range = document.createRange()
    range.selectNodeContents(host)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)

    expect(hasHostTextSelection()).toBe(true)

    window.getSelection()?.removeAllRanges()
    expect(hasHostTextSelection()).toBe(false)
  })
})

describe('isNativeCopyChord', () => {
  const chord = (over: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({
      key: 'c',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...over
    }) as KeyboardEvent

  it('recognizes the platform copy chord', () => {
    expect(isNativeCopyChord(chord({ metaKey: true }), 'darwin')).toBe(true)
    expect(isNativeCopyChord(chord({ ctrlKey: true }), 'win32')).toBe(true)
    expect(isNativeCopyChord(chord({ ctrlKey: true }), 'linux')).toBe(true)
  })

  it('rejects the other platform primary modifier', () => {
    expect(isNativeCopyChord(chord({ ctrlKey: true }), 'darwin')).toBe(false)
    expect(isNativeCopyChord(chord({ metaKey: true }), 'win32')).toBe(false)
  })

  it('rejects a different key', () => {
    expect(isNativeCopyChord(chord({ key: 'g', metaKey: true }), 'darwin')).toBe(false)
  })

  // Why: Ctrl+Shift+C and Alt variants are their own bindings, not the document copy chord, so a
  // grab shortcut mapped to one of them keeps working with text selected.
  it('rejects added Alt or Shift', () => {
    expect(isNativeCopyChord(chord({ metaKey: true, shiftKey: true }), 'darwin')).toBe(false)
    expect(isNativeCopyChord(chord({ metaKey: true, altKey: true }), 'darwin')).toBe(false)
    expect(isNativeCopyChord(chord({ ctrlKey: true, shiftKey: true }), 'linux')).toBe(false)
  })

  it('rejects a bare key with no primary modifier', () => {
    expect(isNativeCopyChord(chord(), 'darwin')).toBe(false)
  })
})
