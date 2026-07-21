// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { shouldCloseActivityPageOnEscapeKey } from './activity-escape-close'

// Why: the helper unit tests cover the decision logic with hand-built objects.
// These tests exercise the real integration seam instead: actual focused DOM
// nodes resolved through document.activeElement, with real classList/closest,
// matching the markup ActivityPrototypePage renders (focusable thread rows and
// the data-activity-terminal-slot-id terminal portal). This catches drift in
// the class name, the slot-id selector, or the focus assumptions that the
// pure-object mocks cannot.
afterEach(() => {
  document.body.innerHTML = ''
})

const ESCAPE = { key: 'Escape', defaultPrevented: false } as const

describe('shouldCloseActivityPageOnEscapeKey (real DOM focus)', () => {
  it('closes when a focused thread row owns focus', () => {
    document.body.innerHTML = `<div role="button" tabindex="0" id="thread-row"></div>`
    const row = document.getElementById('thread-row')
    row?.focus()

    expect(document.activeElement).toBe(row)
    expect(shouldCloseActivityPageOnEscapeKey(ESCAPE, document.activeElement)).toBe(true)
  })

  it('closes when the search filter input owns focus', () => {
    document.body.innerHTML = `<input id="activity-filter" type="text" />`
    const input = document.getElementById('activity-filter')
    input?.focus()

    expect(document.activeElement).toBe(input)
    expect(shouldCloseActivityPageOnEscapeKey(ESCAPE, document.activeElement)).toBe(true)
  })

  it('does not close when a real xterm-helper-textarea owns focus', () => {
    document.body.innerHTML = `
      <div data-activity-terminal-slot-id="primary">
        <textarea class="xterm-helper-textarea"></textarea>
      </div>
    `
    const textarea = document.querySelector('.xterm-helper-textarea')
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.focus()
    }

    expect(document.activeElement).toBe(textarea)
    expect(shouldCloseActivityPageOnEscapeKey(ESCAPE, document.activeElement)).toBe(false)
  })

  it('does not close when focus is a descendant of the terminal portal slot', () => {
    document.body.innerHTML = `
      <div data-activity-terminal-slot-id="secondary">
        <div tabindex="0" id="terminal-child"></div>
      </div>
    `
    const child = document.getElementById('terminal-child')
    child?.focus()

    expect(document.activeElement).toBe(child)
    expect(shouldCloseActivityPageOnEscapeKey(ESCAPE, document.activeElement)).toBe(false)
  })

  it('still ignores already-handled Escape and non-Escape keys from real chrome', () => {
    document.body.innerHTML = `<div role="button" tabindex="0" id="thread-row"></div>`
    document.getElementById('thread-row')?.focus()

    expect(
      shouldCloseActivityPageOnEscapeKey(
        { key: 'Escape', defaultPrevented: true },
        document.activeElement
      )
    ).toBe(false)
    expect(
      shouldCloseActivityPageOnEscapeKey(
        { key: 'Enter', defaultPrevented: false },
        document.activeElement
      )
    ).toBe(false)
  })
})
