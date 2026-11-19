// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { keyEventBelongsToOtherAnnotatePage } from './annotate-esc-ownership'

function element(html: string, selector: string): Element {
  document.body.innerHTML = html
  const found = document.querySelector(selector)
  if (!found) {
    throw new Error(`missing ${selector}`)
  }
  return found
}

describe('annotate Esc ownership', () => {
  it("leaves another page's pane and palette to their own Esc owners", () => {
    const otherPane = element(
      '<div data-browser-page-pane-id="page-2"><button id="t"></button></div>',
      '#t'
    )
    expect(keyEventBelongsToOtherAnnotatePage(otherPane, 'page-1')).toBe(true)

    const otherPalette = element(
      '<div data-browser-annotate-page="page-2"><button id="t"></button></div>',
      '#t'
    )
    expect(keyEventBelongsToOtherAnnotatePage(otherPalette, 'page-1')).toBe(true)
  })

  it("keeps this page's pane, its palette and focus outside any pane", () => {
    const ownPalette = element(
      '<div data-browser-page-pane-id="page-2"><div data-browser-annotate-page="page-1"><button id="t"></button></div></div>',
      '#t'
    )
    expect(keyEventBelongsToOtherAnnotatePage(ownPalette, 'page-1')).toBe(false)
    expect(keyEventBelongsToOtherAnnotatePage(document.body, 'page-1')).toBe(false)
  })
})
