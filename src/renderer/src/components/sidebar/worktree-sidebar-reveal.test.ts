// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isElementVisibleInScrollContainer,
  revealElementInScrollContainer
} from './worktree-sidebar-reveal'

function makeContainer(scrollTop: number, clientHeight: number) {
  const container = document.createElement('div')
  Object.defineProperty(container, 'clientHeight', { value: clientHeight })
  container.scrollTop = scrollTop
  container.getBoundingClientRect = () => new DOMRect(0, 0, 300, clientHeight)
  const scrollTo = vi.fn()
  container.scrollTo = scrollTo
  document.body.append(container)
  return { container, scrollTo }
}

function makeElement(top: number, bottom: number, lineageChildren: Element | null = null): Element {
  const element = document.createElement('div')
  element.id = 'target-option'
  element.setAttribute('data-worktree-card-surface', '')
  element.getBoundingClientRect = () => new DOMRect(0, top, 300, bottom - top)
  if (lineageChildren) {
    lineageChildren.setAttribute('data-worktree-lineage-children', '')
    element.append(lineageChildren)
  }
  document.body.firstElementChild?.append(element)
  return element
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('revealElementInScrollContainer', () => {
  it('reports the scroll target it issues so callers can guard the animation', () => {
    const { container, scrollTo } = makeContainer(0, 673)
    const onScrollIssued = vi.fn()

    // A card mounted below the fold: reveal scrolls until its bottom is in view.
    const revealed = revealElementInScrollContainer(
      container,
      makeElement(1005, 1060),
      'smooth',
      onScrollIssued
    )

    expect(revealed).toBe(true)
    expect(scrollTo).toHaveBeenCalledWith({ top: 387, behavior: 'smooth' })
    expect(onScrollIssued).toHaveBeenCalledWith(387)
  })

  it('ignores expanded child workspaces when revealing a visible parent card', () => {
    const { container, scrollTo } = makeContainer(0, 673)

    // Parent card at 200-320 with 215 expanded children rendered inside it.
    const parent = makeElement(200, 12_000, makeElement(320, 12_000))

    expect(revealElementInScrollContainer(container, parent, 'auto')).toBe(true)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('scrolls only to the parent card, not its children, when the card is below the fold', () => {
    const { container, scrollTo } = makeContainer(0, 673)
    const parent = makeElement(1005, 13_000, makeElement(1060, 13_000))

    revealElementInScrollContainer(container, parent, 'auto')

    expect(scrollTo).toHaveBeenCalledWith({ top: 387, behavior: 'auto' })
  })
})

it('does not treat another valid option id as a leaf boundary', () => {
  const { container, scrollTo } = makeContainer(0, 673)
  const target = makeElement(1005, 1060)
  target.id = 'worktree-list-option-%2Fworktrees%2Ffeature'
  const sibling = makeElement(200, 320)
  sibling.id = `${target.id}-lineage-children`
  revealElementInScrollContainer(container, target, 'auto')
  expect(scrollTo).toHaveBeenCalledWith({ top: 387, behavior: 'auto' })
})

it('keeps generic rows whole and leaves an incomplete card for bounded completion', () => {
  const { container, scrollTo } = makeContainer(0, 673)
  const target = makeElement(1005, 1060)
  target.removeAttribute('data-worktree-card-surface')
  expect(revealElementInScrollContainer(container, target, 'auto')).toBe(true)
  target.setAttribute('data-worktree-id', 'known-card')
  expect(revealElementInScrollContainer(container, target, 'auto')).toBe(false)
  expect(scrollTo).toHaveBeenCalledTimes(1)
})

it('preserves sticky upward clearance and reduced-motion scroll notification', () => {
  const { container, scrollTo } = makeContainer(400, 673)
  const target = makeElement(10, 65)
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  Object.defineProperty(media, 'matches', { value: true })
  vi.spyOn(window, 'matchMedia').mockReturnValue(media)
  const issued = vi.fn()
  expect(revealElementInScrollContainer(container, target, 'smooth', issued)).toBe(true)
  expect(scrollTo).toHaveBeenCalledWith({ top: 376, behavior: 'auto' })
  expect(issued).toHaveBeenCalledWith(376)
})

describe('isElementVisibleInScrollContainer', () => {
  it('agrees with revealElementInScrollContainer that an in-view element needs no scroll', () => {
    const { container } = makeContainer(0, 673)
    expect(isElementVisibleInScrollContainer(container, makeElement(200, 260))).toBe(true)
  })

  it('reports an element below the fold as not visible', () => {
    const { container } = makeContainer(0, 673)
    expect(isElementVisibleInScrollContainer(container, makeElement(1005, 1060))).toBe(false)
  })

  it('reports an element outside the container as not visible', () => {
    const { container } = makeContainer(0, 673)
    const stray = makeElement(200, 260)
    document.body.append(stray)
    expect(isElementVisibleInScrollContainer(container, stray)).toBe(false)
  })

  it('agrees with the parent-card-only reveal judgment when expanded children overflow', () => {
    const { container } = makeContainer(0, 673)
    const parent = makeElement(200, 12_000, makeElement(320, 12_000))
    expect(isElementVisibleInScrollContainer(container, parent)).toBe(true)
  })

  it('reports an incomplete card as not visible, matching the reveal failure path', () => {
    const { container } = makeContainer(0, 673)
    const incomplete = makeElement(200, 260)
    incomplete.removeAttribute('data-worktree-card-surface')
    incomplete.setAttribute('data-worktree-id', 'known-card')
    expect(isElementVisibleInScrollContainer(container, incomplete)).toBe(false)
  })
})
