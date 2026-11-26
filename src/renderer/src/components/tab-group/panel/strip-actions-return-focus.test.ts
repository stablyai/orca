// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { focusStripActionsReturnTarget } from './strip-actions-return-focus'

let trigger: HTMLElement

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
      <div id="actions"><button data-pane-actions-menu-trigger id="trigger"></button></div>
    </div>
    <input id="elsewhere" />`
  trigger = document.getElementById('trigger')!
})

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetParent')
  document.body.innerHTML = ''
})

const owned = (): boolean => true
const hide = (id: string): void => document.getElementById(id)!.setAttribute('hidden', '')

describe('focusStripActionsReturnTarget', () => {
  it("prefers the pane's ⋯ trigger", () => {
    expect(focusStripActionsReturnTarget({ trigger, stillOwned: owned })?.id).toBe('trigger')
    expect(document.activeElement?.id).toBe('trigger')
  })

  it('falls back to the active tab when ⋯ is not shown', () => {
    hide('trigger')
    expect(focusStripActionsReturnTarget({ trigger, stillOwned: owned })?.id).toBe('tab')
    expect(document.activeElement?.id).toBe('tab')
  })

  it('leaves focus alone when neither ⋯ nor a tab slot is shown', () => {
    hide('trigger')
    hide('tab')
    expect(focusStripActionsReturnTarget({ trigger, stillOwned: owned })).toBeNull()
  })

  it('leaves focus alone once another pane owns focus', () => {
    expect(focusStripActionsReturnTarget({ trigger, stillOwned: () => false })).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it('leaves focus alone when something live already holds it', () => {
    const elsewhere = document.getElementById('elsewhere')!
    elsewhere.focus()
    expect(focusStripActionsReturnTarget({ trigger, stillOwned: owned })).toBeNull()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('does nothing once the ⋯ trigger is gone', () => {
    document.getElementById('actions')!.remove()
    expect(focusStripActionsReturnTarget({ trigger, stillOwned: owned })).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })
})
