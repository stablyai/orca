// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { mermaidLabelBox, withMermaidLabelMeasure } from './mermaid-label-measure'

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
})

function label(maxWidth: string, scrollWidth: number, clientWidth: number): HTMLDivElement {
  const div = document.createElement('div')
  div.style.maxWidth = maxWidth
  document.body.append(div)
  Object.defineProperty(div, 'scrollWidth', { configurable: true, value: scrollWidth })
  Object.defineProperty(div, 'clientWidth', { configurable: true, value: clientWidth })
  return div
}

it('reports the wrap cap when an overflowing label measures off the cap', () => {
  const div = label('200px', 348, 200)
  const adjusted = mermaidLabelBox(div, new DOMRect(0, 0, 179.98, 24))
  expect(adjusted.width).toBe(200)
  expect(adjusted.height).toBe(24)
})

it('leaves a label that already fits on one line', () => {
  const div = label('200px', 15, 15)
  const adjusted = mermaidLabelBox(div, new DOMRect(0, 0, 15.03, 18))
  expect(adjusted.width).toBe(15.03)
})

it('leaves an overflowing label whose measure already matches the cap', () => {
  const div = label('200px', 348, 200)
  const adjusted = mermaidLabelBox(div, new DOMRect(0, 0, 200, 24))
  expect(adjusted.width).toBe(200)
})

it('feeds the wrap cap to Mermaid during render and restores measurement afterwards', async () => {
  const div = label('200px', 348, 200)
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    return this === div ? new DOMRect(1, 2, 179.98, 24) : new DOMRect(0, 0, 0, 0)
  }
  let seen = 0
  const result = await withMermaidLabelMeasure(async () => {
    seen = div.getBoundingClientRect().width
    return 'svg'
  })
  expect(result).toBe('svg')
  expect(seen).toBe(200)
  expect(div.getBoundingClientRect().width).toBe(179.98)
})

it('restores measurement when rendering throws', async () => {
  const div = label('200px', 348, 200)
  Element.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 179.98, 24)
  await expect(
    withMermaidLabelMeasure(async () => {
      div.getBoundingClientRect()
      throw new Error('render failed')
    })
  ).rejects.toThrow('render failed')
  expect(div.getBoundingClientRect().width).toBe(179.98)
})
