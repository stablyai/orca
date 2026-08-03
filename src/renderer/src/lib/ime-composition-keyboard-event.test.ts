// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  _setDocumentImeCompositionActiveForTests,
  isDocumentImeCompositionActive,
  isImeCompositionKeyDown
} from './ime-composition-keyboard-event'

function keyEvent(nativeEvent: {
  isComposing?: boolean
  key?: string
  keyCode?: number
}): ReactKeyboardEvent {
  return {
    nativeEvent: {
      isComposing: nativeEvent.isComposing ?? false,
      key: nativeEvent.key ?? 'Enter',
      keyCode: nativeEvent.keyCode ?? 13
    }
  } as unknown as ReactKeyboardEvent
}

function dispatchOnBody(type: string): void {
  document.body.dispatchEvent(new CompositionEvent(type, { bubbles: true, data: '' }))
}

afterEach(() => {
  _setDocumentImeCompositionActiveForTests(false)
})

describe('isImeCompositionKeyDown', () => {
  it('is true while the IME is composing', () => {
    expect(isImeCompositionKeyDown(keyEvent({ isComposing: true }))).toBe(true)
  })

  it('is true for the keyCode 229 fallback when isComposing is not set', () => {
    expect(isImeCompositionKeyDown(keyEvent({ isComposing: false, keyCode: 229 }))).toBe(true)
  })

  it('is true for the Process key some engines report instead of 229', () => {
    expect(isImeCompositionKeyDown(keyEvent({ key: 'Process', keyCode: 0 }))).toBe(true)
  })

  it('is false for a plain Enter outside of composition', () => {
    expect(isImeCompositionKeyDown(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false)
  })

  it.each([
    ['ArrowDown', 40],
    ['Backspace', 8],
    ['Escape', 27],
    ['a', 65]
  ])('leaves a plain %s outside composition alone', (key, keyCode) => {
    expect(isImeCompositionKeyDown(keyEvent({ key, keyCode }))).toBe(false)
  })

  it('accepts a native KeyboardEvent as well as a React synthetic event', () => {
    const native = new KeyboardEvent('keydown', { isComposing: true, key: 'Enter' })

    expect(isImeCompositionKeyDown(native)).toBe(true)
  })

  it('falls back to the document flag when handed no event', () => {
    _setDocumentImeCompositionActiveForTests(true)

    expect(isImeCompositionKeyDown(null)).toBe(true)
    expect(isImeCompositionKeyDown(undefined)).toBe(true)
  })
})

describe('document composition tracking', () => {
  it('suppresses the extra keydown Safari emits after compositionend', () => {
    // compositionend has already cleared the flag by the time this arrives, so the
    // numeric 229 marker is the only bit left that can catch it.
    dispatchOnBody('compositionstart')
    dispatchOnBody('compositionend')
    expect(isDocumentImeCompositionActive()).toBe(false)

    expect(isImeCompositionKeyDown(keyEvent({ isComposing: false, keyCode: 229 }))).toBe(true)
  })

  it('suppresses a key that arrives mid-composition carrying no marker of its own', () => {
    dispatchOnBody('compositionstart')

    expect(isImeCompositionKeyDown(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(true)
  })

  it('still suppresses an Escape the IME actually marked', () => {
    dispatchOnBody('compositionstart')

    expect(
      isImeCompositionKeyDown(keyEvent({ isComposing: true, key: 'Escape', keyCode: 27 }))
    ).toBe(true)
    expect(isImeCompositionKeyDown(keyEvent({ key: 'Escape', keyCode: 229 }))).toBe(true)
  })

  it('lets an unmarked Escape through so a drifted flag cannot strand the cancel path', () => {
    // No compositionend is guaranteed, so nothing else would clear this. Every
    // rename field, search box and picker in the app cancels on Escape.
    dispatchOnBody('compositionstart')

    expect(isImeCompositionKeyDown(keyEvent({ key: 'Escape', keyCode: 27 }))).toBe(false)
    expect(isImeCompositionKeyDown(keyEvent({ key: 'Enter', keyCode: 13 }))).toBe(true)
  })

  it('tracks composition anywhere in the document', () => {
    dispatchOnBody('compositionstart')
    expect(isDocumentImeCompositionActive()).toBe(true)

    dispatchOnBody('compositionend')
    expect(isDocumentImeCompositionActive()).toBe(false)
  })

  it('clears the flag on focus loss because compositionend may never arrive', () => {
    dispatchOnBody('compositionstart')
    expect(isDocumentImeCompositionActive()).toBe(true)

    document.body.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))

    expect(isDocumentImeCompositionActive()).toBe(false)
  })

  it('does not leave Enter permanently suppressed after an abandoned composition', () => {
    dispatchOnBody('compositionstart')
    document.body.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))

    expect(isImeCompositionKeyDown(keyEvent({ keyCode: 13 }))).toBe(false)
  })

  it('clears the flag when the composing element unmounts without focusout', () => {
    // Chromium fires no focusout when a focused node is removed, so a composer
    // that unmounts mid-composition would otherwise latch this on for good.
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    expect(isDocumentImeCompositionActive()).toBe(true)

    input.remove()

    expect(isDocumentImeCompositionActive()).toBe(false)
    expect(isImeCompositionKeyDown(keyEvent({ keyCode: 13 }))).toBe(false)
  })
})
