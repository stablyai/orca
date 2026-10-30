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
  it('ignores an overlay inside an aria-hidden subtree', () => {
    mount('<div aria-hidden="true"><div role="dialog"></div></div>')

    expect(hasVisibleOverlay()).toBe(false)
  })

  it('ignores the persistent workspace list while preserving its nested popups', () => {
    mount('<div role="listbox" data-worktree-sidebar></div>')

    expect(hasVisibleOverlay()).toBe(false)

    mount('<div role="listbox" data-worktree-sidebar><div role="menu"></div></div>')

    expect(hasVisibleOverlay()).toBe(true)
  })

  it('ignores overlays inside ignoreSelector but not their siblings', () => {
    mount('<div data-page-list="true"><div role="listbox"></div></div><div role="menu"></div>')

    expect(hasVisibleOverlay({ ignoreSelector: '[data-page-list="true"]' })).toBe(true)

    document.querySelector('[role="menu"]')?.remove()

    expect(hasVisibleOverlay({ ignoreSelector: '[data-page-list="true"]' })).toBe(false)
  })
})
