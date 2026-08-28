import { describe, expect, it } from 'vitest'
import { shouldFocusPaneTerminal } from './pane-active-focus'

// Sibling pane-manager suites run on the node environment, so stand-ins replace
// real DOM nodes; the decision only ever compares identity.
const textarea = (): HTMLTextAreaElement => ({}) as HTMLTextAreaElement
const element = (): Element => ({}) as Element

describe('shouldFocusPaneTerminal', () => {
  it('focuses a terminal whose textarea does not hold focus', () => {
    expect(shouldFocusPaneTerminal(textarea(), element())).toBe(true)
  })

  it('focuses when nothing on the page holds focus', () => {
    expect(shouldFocusPaneTerminal(textarea(), null)).toBe(true)
  })

  // The regression this guards: re-activating the already-focused pane fired a
  // redundant textarea.focus() on every churned React effect, which can drop an
  // in-flight IME preedit.
  it('skips the redundant call when the textarea already holds focus', () => {
    const focused = textarea()
    expect(shouldFocusPaneTerminal(focused, focused)).toBe(false)
  })

  it('still focuses a terminal that has not opened its textarea yet', () => {
    expect(shouldFocusPaneTerminal(undefined, element())).toBe(true)
    expect(shouldFocusPaneTerminal(null, null)).toBe(true)
  })
})
