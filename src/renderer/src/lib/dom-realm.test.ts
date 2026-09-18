// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { getDomRealm } from './dom-realm'

describe('getDomRealm', () => {
  it("returns the view's own constructors for a foreign window", () => {
    class ForeignElement {}
    class ForeignNode {}
    class ForeignHTMLElement {}
    const getComputedStyle = vi.fn()
    const realm = getDomRealm({
      Element: ForeignElement,
      Node: ForeignNode,
      HTMLElement: ForeignHTMLElement,
      getComputedStyle
    } as unknown as Window)

    expect(realm.Element).toBe(ForeignElement)
    expect(realm.Node).toBe(ForeignNode)
    expect(realm.HTMLElement).toBe(ForeignHTMLElement)
  })

  it('recognizes foreign-realm nodes the global constructors miss', () => {
    // Why: the popout runs a separate JS realm — this is the exact shape
    // detached nodes have: missed by main-realm instanceof, caught by the
    // resolved one.
    class ForeignElement {}
    const node = Object.create(ForeignElement.prototype)
    const realm = getDomRealm({ Element: ForeignElement } as unknown as Window)

    expect(node instanceof Element).toBe(false)
    expect(node instanceof realm.Element).toBe(true)
  })

  it('falls back to the global constructors without a view', () => {
    expect(getDomRealm(null).Element).toBe(Element)
    expect(getDomRealm(undefined).Node).toBe(Node)
    expect(getDomRealm(undefined).HTMLElement).toBe(HTMLElement)
  })

  it('resolves the main window to the global constructors', () => {
    const realm = getDomRealm(window)
    expect(realm.Element).toBe(Element)
    expect(realm.Node).toBe(Node)
    expect(realm.HTMLElement).toBe(HTMLElement)
  })

  it("delegates getComputedStyle to the node's own view when present", () => {
    const style = {} as CSSStyleDeclaration
    const viewGetComputedStyle = vi.fn(() => style)
    const el = document.createElement('div')

    const foreign = getDomRealm({
      getComputedStyle: viewGetComputedStyle
    } as unknown as Window)
    expect(foreign.getComputedStyle(el)).toBe(style)
    expect(viewGetComputedStyle).toHaveBeenCalledWith(el)

    const fallback = getDomRealm(null)
    expect(fallback.getComputedStyle(el)).toBe(getComputedStyle(el))
  })
})
