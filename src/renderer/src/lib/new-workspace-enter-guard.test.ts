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
  private readonly children = new Set<FakeHTMLElement>()

  append(child: FakeHTMLElement): void {
    this.children.add(child)
  }

  contains(target: EventTarget): boolean {
    return target === this || this.children.has(target as FakeHTMLElement)
  }
}

let previousHTMLElement: typeof globalThis.HTMLElement | undefined
let previousDocument: typeof globalThis.document | undefined

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
    previousDocument = globalThis.document
    const body = new FakeHTMLElement()
    const documentElement = new FakeHTMLElement()
    Object.defineProperty(globalThis, 'HTMLElement', {
      configurable: true,
      value: FakeHTMLElement
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { body, documentElement }
    })
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'HTMLElement', {
      configurable: true,
      value: previousHTMLElement
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: previousDocument
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

  it('allows body/document targets after a source selection drops focus', () => {
    const composer = new FakeHTMLElement()

    expect(
      shouldAllowComposerEnterSubmitTarget(document.body, composer as unknown as HTMLElement)
    ).toBe(true)
    expect(
      shouldAllowComposerEnterSubmitTarget(
        document.documentElement,
        composer as unknown as HTMLElement
      )
    ).toBe(true)
  })

  it('rejects targets outside the composer', () => {
    const composer = new FakeHTMLElement()
    const outside = new FakeHTMLElement()

    expect(shouldAllowComposerEnterSubmitTarget(outside, composer as unknown as HTMLElement)).toBe(
      false
    )
  })
})
