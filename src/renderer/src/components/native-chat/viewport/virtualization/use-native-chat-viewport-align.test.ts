// @vitest-environment happy-dom

// The gap between a run's slots is measured in Chromium (tests/component-fixtures/native-chat-note-run.spec.ts).
import { describe, expect, it } from 'vitest'
import { nativeChatRowDrawnAbove } from './use-native-chat-viewport-align'

describe('where a jump lands a row', () => {
  function row(wrapperTop: number, contentTop: number): HTMLElement {
    const wrapper = document.createElement('div')
    const content = document.createElement('div')
    wrapper.append(content)
    wrapper.getBoundingClientRect = () => new DOMRect(0, wrapperTop, 100, 40)
    content.getBoundingClientRect = () => new DOMRect(0, contentTop, 100, 56)
    return wrapper
  }

  it('lands a slot that pulls up into the gap by its first note, not by its own top', () => {
    expect(nativeChatRowDrawnAbove(row(200, 184))).toBe(16)
  })

  it('lands every other row by its own top', () => {
    expect(nativeChatRowDrawnAbove(row(200, 200))).toBe(0)
    expect(nativeChatRowDrawnAbove(document.createElement('div'))).toBe(0)
  })
})
