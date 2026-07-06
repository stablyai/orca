// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  hasCjkCompositionText,
  installTerminalImeCompositionTracker
} from './terminal-ime-composition-tracker'

function compositionUpdateEvent(data: string): Event {
  const event = new Event('compositionupdate')
  Object.defineProperty(event, 'data', { value: data })
  return event
}

describe('hasCjkCompositionText', () => {
  it('accepts Han, Kana, Bopomofo and Hangul composition text', () => {
    expect(hasCjkCompositionText('中')).toBe(true)
    expect(hasCjkCompositionText('に')).toBe(true)
    expect(hasCjkCompositionText('カ')).toBe(true)
    expect(hasCjkCompositionText('ㄅ')).toBe(true)
    expect(hasCjkCompositionText('ᄒ')).toBe(true)
    expect(hasCjkCompositionText('한')).toBe(true)
  })

  it('rejects Latin and Vietnamese inline composition text', () => {
    expect(hasCjkCompositionText(null)).toBe(false)
    expect(hasCjkCompositionText('')).toBe(false)
    expect(hasCjkCompositionText('nihao')).toBe(false)
    expect(hasCjkCompositionText('chào')).toBe(false)
    expect(hasCjkCompositionText('đ')).toBe(false)
  })
})

describe('installTerminalImeCompositionTracker', () => {
  it('tracks CJK script while a composition is active', () => {
    const element = document.createElement('div')
    const tracker = installTerminalImeCompositionTracker(element)

    element.dispatchEvent(new CompositionEvent('compositionstart'))
    expect(tracker.isActive()).toBe(true)
    expect(tracker.hasCjkCompositionText()).toBe(false)

    element.dispatchEvent(compositionUpdateEvent('に'))
    expect(tracker.isActive()).toBe(true)
    expect(tracker.hasCjkCompositionText()).toBe(true)

    element.dispatchEvent(new CompositionEvent('compositionend'))
    expect(tracker.isActive()).toBe(false)
    expect(tracker.hasCjkCompositionText()).toBe(false)

    tracker.dispose()
  })

  it('keeps Vietnamese composition active without marking it CJK', () => {
    const element = document.createElement('div')
    const tracker = installTerminalImeCompositionTracker(element)

    element.dispatchEvent(new CompositionEvent('compositionstart'))
    element.dispatchEvent(compositionUpdateEvent('â'))

    expect(tracker.isActive()).toBe(true)
    expect(tracker.hasCjkCompositionText()).toBe(false)

    tracker.dispose()
  })

  it('does not expose stale CJK text after regular input commits', () => {
    const element = document.createElement('div')
    const tracker = installTerminalImeCompositionTracker(element)

    element.dispatchEvent(new CompositionEvent('compositionstart'))
    element.dispatchEvent(compositionUpdateEvent('한'))
    element.dispatchEvent(new InputEvent('input', { data: '한', inputType: 'insertText' }))

    expect(tracker.isActive()).toBe(false)
    expect(tracker.hasCjkCompositionText()).toBe(false)

    tracker.dispose()
  })

  it('is inert without a terminal element', () => {
    const tracker = installTerminalImeCompositionTracker(null)

    expect(tracker.isActive()).toBe(false)
    expect(tracker.hasCjkCompositionText()).toBe(false)
    expect(() => tracker.dispose()).not.toThrow()
  })
})
