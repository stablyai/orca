import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import {
  shouldAllowComposerEnterSubmitTarget,
  shouldSuppressEnterSubmit
} from './new-workspace-enter-guard'

function makeEvent(overrides: Partial<{ isComposing: boolean; shiftKey: boolean }>): {
  isComposing: boolean
  shiftKey: boolean
} {
  return { isComposing: false, shiftKey: false, ...overrides }
}

class FakeHTMLElement extends EventTarget {
  private readonly descendants = new Set<FakeHTMLElement>()

  append(child: FakeHTMLElement): void {
    this.descendants.add(child)
  }

  contains(target: EventTarget): boolean {
    return target === this || this.descendants.has(target as FakeHTMLElement)
  }
}

let previousHTMLElement: typeof globalThis.HTMLElement | undefined

describe('shouldSuppressEnterSubmit', () => {
  it('returns false for a plain Enter with no composition', () => {
    expect(shouldSuppressEnterSubmit(makeEvent({}), false)).toBe(false)
  })

  it('returns true when IME composition is active', () => {
    expect(shouldSuppressEnterSubmit(makeEvent({ isComposing: true }), false)).toBe(true)
  })

  it('returns true for Shift+Enter inside a textarea', () => {
    expect(shouldSuppressEnterSubmit(makeEvent({ shiftKey: true }), true)).toBe(true)
  })

  it('returns false for Shift+Enter inside a non-textarea element', () => {
    expect(shouldSuppressEnterSubmit(makeEvent({ shiftKey: true }), false)).toBe(false)
  })

  it('returns true when both isComposing and shiftKey are true (textarea)', () => {
    expect(shouldSuppressEnterSubmit(makeEvent({ isComposing: true, shiftKey: true }), true)).toBe(
      true
    )
  })
})

describe('shouldAllowComposerEnterSubmitTarget', () => {
  beforeEach(() => {
    previousHTMLElement = globalThis.HTMLElement
    Object.defineProperty(globalThis, 'HTMLElement', {
      configurable: true,
      value: FakeHTMLElement
    })
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'HTMLElement', {
      configurable: true,
      value: previousHTMLElement
    })
  })

  it('allows targets inside the composer', () => {
    const composer = new FakeHTMLElement()
    const input = new FakeHTMLElement()
    composer.append(input)

    expect(shouldAllowComposerEnterSubmitTarget(input, composer as unknown as HTMLElement)).toBe(
      true
    )
  })

  it('allows ancestor targets after a source selection drops focus', () => {
    // Why: post-selection focus can land on body, html, or the DialogContent
    // root — any ancestor wrapping the composer is a legitimate fallback.
    const composer = new FakeHTMLElement()
    const dialogContent = new FakeHTMLElement()
    const body = new FakeHTMLElement()
    dialogContent.append(composer)
    body.append(composer)
    body.append(dialogContent)

    expect(
      shouldAllowComposerEnterSubmitTarget(dialogContent, composer as unknown as HTMLElement)
    ).toBe(true)
    expect(shouldAllowComposerEnterSubmitTarget(body, composer as unknown as HTMLElement)).toBe(
      true
    )
  })

  it('rejects sibling targets outside the composer', () => {
    const composer = new FakeHTMLElement()
    const outside = new FakeHTMLElement()

    expect(shouldAllowComposerEnterSubmitTarget(outside, composer as unknown as HTMLElement)).toBe(
      false
    )
  })
})
