// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import {
  hasHostTextSelection,
  isEditableKeyboardTarget,
  isNativeCopyChord,
  isTerminalKeyboardTarget,
  shouldYieldGrabCopyChordToHostCopy
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

  it('returns false for a collapsed caret or whitespace-only range', () => {
    expect(hasHostTextSelection({ isCollapsed: true, toString: () => '' })).toBe(false)
    expect(hasHostTextSelection({ isCollapsed: false, toString: () => '  \n ' })).toBe(false)
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: tests only read the key/modifier fields the helper uses.
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

  it('rejects the other platform primary modifier, Shift/Alt, and other keys', () => {
    expect(isNativeCopyChord(chord({ ctrlKey: true }), 'darwin')).toBe(false)
    expect(isNativeCopyChord(chord({ metaKey: true }), 'win32')).toBe(false)
    expect(isNativeCopyChord(chord({ key: 'g', metaKey: true }), 'darwin')).toBe(false)
    expect(isNativeCopyChord(chord({ metaKey: true, shiftKey: true }), 'darwin')).toBe(false)
    expect(isNativeCopyChord(chord({ metaKey: true, altKey: true }), 'darwin')).toBe(false)
    expect(isNativeCopyChord(chord(), 'darwin')).toBe(false)
  })
})

describe('isTerminalKeyboardTarget', () => {
  it('matches the xterm helper textarea and descendants of .xterm', () => {
    const helper = targetInside(
      '<div class="xterm"><textarea class="xterm-helper-textarea" data-target></textarea></div>'
    )
    expect(isTerminalKeyboardTarget(helper)).toBe(true)
    expect(
      isTerminalKeyboardTarget(
        targetInside('<div class="xterm"><canvas data-target></canvas></div>')
      )
    ).toBe(true)
    expect(isTerminalKeyboardTarget(targetInside('<div data-target></div>'))).toBe(false)
    expect(isTerminalKeyboardTarget(null)).toBe(false)
  })
})

describe('shouldYieldGrabCopyChordToHostCopy', () => {
  const cmdC = {
    key: 'c',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: null as EventTarget | null
  }

  it('yields the platform copy chord for host text or terminal selection', () => {
    expect(
      shouldYieldGrabCopyChordToHostCopy(cmdC, 'darwin', {
        hostSelection: { isCollapsed: false, toString: () => 'hi' },
        terminalHasSelection: false
      })
    ).toBe(true)
    expect(
      shouldYieldGrabCopyChordToHostCopy(cmdC, 'darwin', {
        hostSelection: null,
        terminalHasSelection: true
      })
    ).toBe(true)
  })

  it('yields when the event target is the terminal surface', () => {
    const helper = targetInside(
      '<div class="xterm"><textarea class="xterm-helper-textarea" data-target></textarea></div>'
    )
    expect(
      shouldYieldGrabCopyChordToHostCopy({ ...cmdC, target: helper }, 'darwin', {
        hostSelection: null,
        terminalHasSelection: false
      })
    ).toBe(true)
  })

  it('keeps grab when nothing is selected and the target is not a terminal', () => {
    expect(
      shouldYieldGrabCopyChordToHostCopy(cmdC, 'darwin', {
        hostSelection: null,
        terminalHasSelection: false
      })
    ).toBe(false)
  })

  it('does not yield a non-copy grab chord even with a selection', () => {
    expect(
      shouldYieldGrabCopyChordToHostCopy({ ...cmdC, shiftKey: true }, 'darwin', {
        hostSelection: { isCollapsed: false, toString: () => 'hi' },
        terminalHasSelection: true
      })
    ).toBe(false)
  })
})
