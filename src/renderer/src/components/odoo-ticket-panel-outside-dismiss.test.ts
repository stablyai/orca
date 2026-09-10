import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isOdooTicketPanelKeepOpenTarget } from './odoo-ticket-panel-outside-dismiss'

class FakeNode {
  parentElement: FakeElement | null = null
}

class FakeElement extends FakeNode {
  private readonly attributes: ReadonlySet<string>

  constructor(attributes: readonly string[] = [], parentElement: FakeElement | null = null) {
    super()
    this.attributes = new Set(attributes)
    this.parentElement = parentElement
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) {
      return this
    }
    return this.parentElement?.closest(selector) ?? null
  }

  private matches(selector: string): boolean {
    return selector
      .split(',')
      .map((part) => part.trim())
      .some((part) => this.attributes.has(part))
  }
}

describe('isOdooTicketPanelKeepOpenTarget', () => {
  beforeEach(() => {
    vi.stubGlobal('Node', FakeNode)
    vi.stubGlobal('Element', FakeElement)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the panel open for clicks inside the ticket list/toolbar', () => {
    const panel = new FakeElement(['[data-odoo-panel]'])
    const row = new FakeElement([], panel)
    expect(isOdooTicketPanelKeepOpenTarget(row as unknown as EventTarget)).toBe(true)
  })

  it('keeps the panel open for clicks inside a portaled filter dropdown', () => {
    const popper = new FakeElement(['[data-radix-popper-content-wrapper]'])
    const option = new FakeElement([], popper)
    expect(isOdooTicketPanelKeepOpenTarget(option as unknown as EventTarget)).toBe(true)
  })

  it('dismisses for a click in the void', () => {
    const elsewhere = new FakeElement()
    expect(isOdooTicketPanelKeepOpenTarget(elsewhere as unknown as EventTarget)).toBe(false)
  })

  it('dismisses when the target is null', () => {
    expect(isOdooTicketPanelKeepOpenTarget(null)).toBe(false)
  })

  it('resolves a text node to its parent before matching', () => {
    const panel = new FakeElement(['[data-odoo-panel]'])
    const text = new FakeNode()
    text.parentElement = panel
    expect(isOdooTicketPanelKeepOpenTarget(text as unknown as EventTarget)).toBe(true)
  })
})
