// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { equalizePaneSplitSizes, findPaneChildren } from './pane-tree-equalization'

type Direction = 'vertical' | 'horizontal'

/** The pre-cache weight walk, as the differential oracle. */
function referenceWeight(el: HTMLElement, direction: Direction): number {
  if (!el.classList.contains('pane-split')) {
    return 1
  }
  const own = el.classList.contains('is-horizontal') ? 'horizontal' : 'vertical'
  if (own !== direction) {
    return 1
  }
  return Math.max(
    1,
    findPaneChildren(el).reduce((sum, child) => sum + referenceWeight(child, direction), 0)
  )
}

/** The pre-cache sweep, writing into a parallel attribute so both can be compared. */
function referenceEqualize(el: HTMLElement): void {
  if (!el.classList.contains('pane-split')) {
    return
  }
  const direction: Direction = el.classList.contains('is-horizontal') ? 'horizontal' : 'vertical'
  const children = findPaneChildren(el)
  if (children.length >= 2) {
    for (const child of children) {
      child.dataset.expectedFlex = `${referenceWeight(child, direction)} 1 0%`
    }
  }
  for (const child of children) {
    referenceEqualize(child)
  }
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

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

/** Random split tree with mixed axes, 2-4 children per split, and dividers interleaved. */
function makeTree(random: () => number, depth: number): HTMLElement {
  if (depth <= 0 || random() < 0.35) {
    return makePane()
  }
  const split = document.createElement('div')
  split.className = random() < 0.5 ? 'pane-split is-horizontal' : 'pane-split'
  const childCount = 2 + Math.floor(random() * 3)
  for (let i = 0; i < childCount; i += 1) {
    if (i > 0) {
      split.append(makeDivider())
    }
    split.append(makeTree(random, depth - 1))
  }
  return split
}

function allElements(root: HTMLElement): HTMLElement[] {
  return [root, ...Array.from(root.querySelectorAll<HTMLElement>('.pane, .pane-split'))]
}

it('produces the same flex on every element as the uncached weight walk', () => {
  let splitCases = 0
  for (let seed = 1; seed <= 400; seed += 1) {
    const random = makeRandom(seed)
    const root = makeTree(random, 5)
    referenceEqualize(root)
    equalizePaneSplitSizes(root)
    for (const element of allElements(root)) {
      expect(element.style.flex || undefined, `seed ${seed}`).toEqual(element.dataset.expectedFlex)
      if (element.dataset.expectedFlex) {
        splitCases += 1
      }
    }
  }
  expect(splitCases).toBeGreaterThan(1000)
})

it('keeps every split weight equal to the integer sum of its same-axis children', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const root = makeTree(makeRandom(seed), 5)
    equalizePaneSplitSizes(root)
    for (const split of allElements(root).filter((el) => el.classList.contains('pane-split'))) {
      const children = findPaneChildren(split)
      if (children.length < 2) {
        continue
      }
      const direction: Direction = split.classList.contains('is-horizontal')
        ? 'horizontal'
        : 'vertical'
      const total = children.reduce((sum, child) => {
        const grow = Number(child.style.flex.split(' ')[0])
        // Integer weights only: no float drift can make the row fail to fill.
        expect(Number.isInteger(grow)).toBe(true)
        expect(grow).toBeGreaterThanOrEqual(1)
        return sum + grow
      }, 0)
      expect(total, `seed ${seed}`).toBe(referenceWeight(split, direction))
    }
  }
})

it('recomputes weights after a split is added and after one is closed', () => {
  const root = document.createElement('div')
  root.className = 'pane-split'
  const left = makePane()
  const right = makePane()
  root.append(left, makeDivider(), right)
  equalizePaneSplitSizes(root)
  expect(left.style.flex).toBe('1 1 0%')

  // Split the right pane on the same axis: the parent must re-weight it to 2.
  const nested = document.createElement('div')
  nested.className = 'pane-split'
  nested.append(makePane(), makeDivider(), makePane())
  right.replaceWith(nested)
  expect(equalizePaneSplitSizes(root)).toBe(true)
  expect(nested.style.flex).toBe('2 1 0%')
  expect(left.style.flex).toBe('1 1 0%')

  // Close one of the nested panes: the weight must drop back to 1.
  nested.lastElementChild!.remove()
  expect(equalizePaneSplitSizes(root)).toBe(true)
  expect(nested.style.flex).toBe('1 1 0%')

  // A resize sweep with no structural change writes nothing.
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
