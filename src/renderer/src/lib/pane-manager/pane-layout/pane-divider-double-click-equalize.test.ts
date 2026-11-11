// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { attachDividerDrag } from './pane-divider-drag'

function pane(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'pane'
  return el
}

function split(direction: 'vertical' | 'horizontal', ...children: HTMLElement[]): HTMLElement {
  const el = document.createElement('div')
  el.className = `pane-split is-${direction}`
  children.forEach((child, index) => {
    if (index > 0) {
      const divider = document.createElement('div')
      divider.className = 'pane-divider'
      el.append(divider)
    }
    el.append(child)
  })
  return el
}

function attach(divider: HTMLElement) {
  const callbacks = {
    refitPanesUnder: vi.fn(),
    onLayoutChanged: vi.fn(),
    onDividerRatiosCommitted: vi.fn()
  }
  attachDividerDrag(divider, true, callbacks)
  return callbacks
}

const dividerOf = (el: HTMLElement) => el.querySelector<HTMLElement>(':scope > .pane-divider')!
const doubleClick = (el: Element) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

describe('pane divider double-click', () => {
  it('equalizes the whole row, not just the two neighbors', () => {
    const [a, b, c] = [pane(), pane(), pane()]
    const inner = split('vertical', b, c)
    const root = split('vertical', a, inner)
    a.style.flex = '2 1 0%'
    inner.style.flex = '1 1 0%'
    const callbacks = attach(dividerOf(inner))

    doubleClick(dividerOf(inner))

    expect([a.style.flex, inner.style.flex, b.style.flex, c.style.flex]).toEqual([
      '1 1 0%',
      '2 1 0%',
      '1 1 0%',
      '1 1 0%'
    ])
    expect(callbacks.refitPanesUnder).toHaveBeenCalledWith(root)
    expect(callbacks.onLayoutChanged).toHaveBeenCalledTimes(1)
    expect(callbacks.onDividerRatiosCommitted).toHaveBeenCalledTimes(1)
  })

  it('counts a cross-axis split as one slot and keeps its own ratio', () => {
    const [a, top, bottom, c] = [pane(), pane(), pane(), pane()]
    top.style.flex = '3 1 0%'
    const column = split('horizontal', top, bottom)
    const inner = split('vertical', column, c)
    split('vertical', a, inner)
    a.style.flex = '2 1 0%'
    attach(dividerOf(inner))

    doubleClick(dividerOf(inner))

    expect([a.style.flex, inner.style.flex, column.style.flex, c.style.flex]).toEqual([
      '1 1 0%',
      '2 1 0%',
      '1 1 0%',
      '1 1 0%'
    ])
    expect(top.style.flex).toBe('3 1 0%')
  })

  it('reports nothing when the row is already equal', () => {
    const [a, b] = [pane(), pane()]
    a.style.flex = '1 1 0%'
    b.style.flex = '1 1 0%'
    const root = split('vertical', a, b)
    const callbacks = attach(dividerOf(root))

    doubleClick(dividerOf(root))

    expect(callbacks.onLayoutChanged).not.toHaveBeenCalled()
    expect(callbacks.onDividerRatiosCommitted).not.toHaveBeenCalled()
  })
})
