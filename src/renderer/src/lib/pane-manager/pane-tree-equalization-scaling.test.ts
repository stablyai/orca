// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { equalizePaneSplitSizes } from './pane-tree-equalization'

it('computes nested same-axis pane weights once per split', () => {
  const pane = () => {
    const element = document.createElement('div')
    element.className = 'pane'
    return element
  }
  let root = pane()
  let reads = 0
  const children = Object.getOwnPropertyDescriptor(Element.prototype, 'children')!.get!
  for (let index = 0; index < 200; index += 1) {
    const split = document.createElement('div')
    split.className = 'pane-split'
    split.append(pane(), root)
    Object.defineProperty(split, 'children', {
      get() {
        reads += 1
        return children.call(this)
      }
    })
    root = split
  }
  expect(equalizePaneSplitSizes(root)).toBe(true)
  expect(reads).toBeLessThan(500)
  expect((root.lastElementChild as HTMLElement).style.flex).toBe('200 1 0%')
  expect(equalizePaneSplitSizes(root)).toBe(false)
})
