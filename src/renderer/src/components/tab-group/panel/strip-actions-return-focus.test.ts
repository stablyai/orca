// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { focusStripActionsReturnTarget } from './strip-actions-return-focus'

let actions: HTMLElement

beforeEach(() => {
  // happy-dom has no layout; treat connected elements without the `hidden` attribute as shown.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected && !this.closest('[hidden]') ? document.body : null
    }
  })
  document.body.innerHTML = `
    <div data-tab-group-strip-id="g1">
      <div data-tab-strip-slot="t1"><div tabindex="0" id="tab" data-active="true"></div></div>
      <button data-tab-strip-overflow-chip id="chip"></button>
      <div id="actions"><button data-pane-actions-menu-trigger id="trigger"></button></div>
    </div>
    <input id="elsewhere" />`
  actions = document.getElementById('actions')!
})

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetParent')
  document.body.innerHTML = ''
})

const owned = (): boolean => true
const hide = (id: string): void => document.getElementById(id)!.setAttribute('hidden', '')

describe('focusStripActionsReturnTarget', () => {
  it("prefers the pane's ⋯ trigger", () => {
    expect(focusStripActionsReturnTarget({ actions, stillOwned: owned })?.id).toBe('trigger')
    expect(document.activeElement?.id).toBe('trigger')
  })

  it('falls back to the active tab when ⋯ is not shown', () => {
    hide('trigger')
    expect(focusStripActionsReturnTarget({ actions, stillOwned: owned })?.id).toBe('tab')
    expect(document.activeElement?.id).toBe('tab')
  })

  it('falls back to the +N chip when neither ⋯ nor a tab slot is shown', () => {
    hide('trigger')
    hide('tab')
    expect(focusStripActionsReturnTarget({ actions, stillOwned: owned })?.id).toBe('chip')
  })

  it('leaves focus alone once another pane owns focus', () => {
    expect(focusStripActionsReturnTarget({ actions, stillOwned: () => false })).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it('leaves focus alone when something live already holds it', () => {
    const elsewhere = document.getElementById('elsewhere')!
    elsewhere.focus()
    expect(focusStripActionsReturnTarget({ actions, stillOwned: owned })).toBeNull()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('does nothing once the strip actions are gone', () => {
    actions.remove()
    expect(focusStripActionsReturnTarget({ actions, stillOwned: owned })).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })
})
