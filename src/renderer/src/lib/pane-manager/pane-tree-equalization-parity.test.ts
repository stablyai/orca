// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { equalizePaneSplitSizes } from './pane-tree-equalization'

function makePane(): HTMLElement {
  const element = document.createElement('div')
  element.className = 'pane'
  return element
}

function makeDivider(): HTMLElement {
  const element = document.createElement('div')
  element.className = 'pane-divider'
  return element
}

it('recomputes weights after a split is added and after one is closed', () => {
  const root = document.createElement('div')
  root.className = 'pane-split'
  const left = makePane()
  const right = makePane()
  root.append(left, makeDivider(), right)
  equalizePaneSplitSizes(root)
  expect(left.style.flex).toBe('1 1 0%')

  const nested = document.createElement('div')
  nested.className = 'pane-split'
  nested.append(makePane(), makeDivider(), makePane())
  right.replaceWith(nested)
  expect(equalizePaneSplitSizes(root)).toBe(true)
  expect(nested.style.flex).toBe('2 1 0%')
  expect(left.style.flex).toBe('1 1 0%')

  nested.lastElementChild!.remove()
  expect(equalizePaneSplitSizes(root)).toBe(true)
  expect(nested.style.flex).toBe('1 1 0%')

  expect(equalizePaneSplitSizes(root)).toBe(false)
})

it('weights a cross-axis nested split as one unit', () => {
  const root = document.createElement('div')
  root.className = 'pane-split'
  const left = makePane()
  const crossAxis = document.createElement('div')
  crossAxis.className = 'pane-split is-horizontal'
  crossAxis.append(makePane(), makeDivider(), makePane(), makeDivider(), makePane())
  root.append(left, makeDivider(), crossAxis)
  equalizePaneSplitSizes(root)
  expect(crossAxis.style.flex).toBe('1 1 0%')
  expect(left.style.flex).toBe('1 1 0%')
})
