import { describe, expect, it, vi } from 'vitest'
import { revealElementInScrollContainer } from './worktree-sidebar-reveal'

function makeContainer(scrollTop: number, clientHeight: number) {
  const scrollTo = vi.fn()
  const container = {
    clientHeight,
    scrollTop,
    contains: () => true,
    getBoundingClientRect: () => ({ top: 0, bottom: clientHeight }) as DOMRect,
    scrollTo
  }
  return { container: container as unknown as HTMLElement, scrollTo }
}

function makeElement(top: number, bottom: number): Element {
  return {
    getBoundingClientRect: () => ({ top, bottom }) as DOMRect
  } as unknown as Element
}

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

  it('does not report a scroll when the element is already in view', () => {
    const { container, scrollTo } = makeContainer(0, 673)
    const onScrollIssued = vi.fn()

    const revealed = revealElementInScrollContainer(
      container,
      makeElement(200, 260),
      'smooth',
      onScrollIssued
    )

    expect(revealed).toBe(true)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(onScrollIssued).not.toHaveBeenCalled()
  })
})
