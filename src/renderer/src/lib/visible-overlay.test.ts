// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { hasVisibleOverlay } from './visible-overlay'

afterEach(() => {
  document.body.innerHTML = ''
})

function mount(html: string): void {
  document.body.innerHTML = html
}

describe('hasVisibleOverlay', () => {
  it('is false with no overlay on screen', () => {
    mount('<div>page chrome</div>')

    expect(hasVisibleOverlay()).toBe(false)
  })

  it.each(['dialog', 'alertdialog', 'listbox', 'menu'])('sees a visible %s', (role) => {
    mount(`<div role="${role}"></div>`)

    expect(hasVisibleOverlay()).toBe(true)
  })

  it('ignores an overlay inside an aria-hidden subtree', () => {
    mount('<div aria-hidden="true"><div role="dialog"></div></div>')

    expect(hasVisibleOverlay()).toBe(false)
  })

  it('ignores a display:none overlay', () => {
    mount('<div role="dialog" style="display: none"></div>')

    expect(hasVisibleOverlay()).toBe(false)
  })

  it('ignores a visibility:hidden overlay', () => {
    mount('<div role="dialog" style="visibility: hidden"></div>')

    expect(hasVisibleOverlay()).toBe(false)
  })

  it('ignores overlays inside ignoreSelector but not their siblings', () => {
    mount('<div data-page-list="true"><div role="listbox"></div></div><div role="menu"></div>')

    expect(hasVisibleOverlay({ ignoreSelector: '[data-page-list="true"]' })).toBe(true)

    document.querySelector('[role="menu"]')?.remove()

    expect(hasVisibleOverlay({ ignoreSelector: '[data-page-list="true"]' })).toBe(false)
  })
})
