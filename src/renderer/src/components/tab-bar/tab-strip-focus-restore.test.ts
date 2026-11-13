// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { restoreTabStripFocus } from './tab-strip-focus-restore'

let restoreOffsetParent: PropertyDescriptor | undefined

beforeEach(() => {
  restoreOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
  // happy-dom has no layout; treat every connected element as shown.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected ? document.body : null
    }
  })
})

afterEach(() => {
  if (restoreOffsetParent) {
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', restoreOffsetParent)
  }
  document.body.innerHTML = ''
})

function buildStrip(): HTMLElement {
  document.body.innerHTML = `
    <div id="strip">
      <div data-tab-strip-slot="tab"><div tabindex="0" id="tab-root"></div></div>
      <div data-tab-strip-slot="paired"><div id="paired-root"></div></div>
      <button data-tab-strip-overflow-chip id="chip"></button>
    </div>
    <button id="elsewhere"></button>`
  return document.getElementById('strip')!
}

function restore(slotId: string | null, stillOwned = true, focusBefore: Element | null = null) {
  restoreTabStripFocus({
    strip: buildStripOnce(),
    slotId,
    stillOwned: () => stillOwned,
    focusBefore
  })
}

let strip: HTMLElement | null = null
function buildStripOnce(): HTMLElement {
  strip ??= buildStrip()
  return strip
}

describe('restoreTabStripFocus', () => {
  beforeEach(() => {
    strip = null
  })

  it('focuses the picked tab root', () => {
    restore('tab')
    expect(document.activeElement?.id).toBe('tab-root')
  })

  it('falls back to the chip for a slot with no focusable root (paired page)', () => {
    restore('paired')
    expect(document.activeElement?.id).toBe('chip')
  })

  it('falls back to the chip when the slot is not rendered (chip-only or mid re-plan)', () => {
    restore('hidden-tab')
    expect(document.activeElement?.id).toBe('chip')
    restore(null)
    expect(document.activeElement?.id).toBe('chip')
  })

  it('leaves focus alone when the group lost ownership or the user moved focus', () => {
    buildStripOnce()
    const elsewhere = document.getElementById('elsewhere')!
    elsewhere.focus()
    restore('tab', false, elsewhere)
    expect(document.activeElement).toBe(elsewhere)
    restore('tab', true, null)
    expect(document.activeElement).toBe(elsewhere)
  })
})
