// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { revealElementInScrollContainer } from '../../worktree-sidebar-reveal'
import { createMountedRevealSmoothTarget } from './mounted-reveal-smooth-target'

function fixture(scrollTop = 0, top = 10_000) {
  const container = document.createElement('div')
  const element = document.createElement('div')
  const geometry = { top, height: 55 }
  container.append(element)
  container.scrollTop = scrollTop
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true })
  container.getBoundingClientRect = () => new DOMRect(0, 100, 200, 600)
  element.getBoundingClientRect = () =>
    new DOMRect(0, 100 + geometry.top - container.scrollTop, 200, geometry.height)
  const scrollTo = vi.fn()
  container.scrollTo = scrollTo
  const markScroll = vi.fn()
  return { container, element, geometry, scrollTo, markScroll }
}

afterEach(() => vi.restoreAllMocks())

describe('measured smooth reveal destination', () => {
  it('aims at the title of an oversized card from the initial native write', () => {
    const f = fixture(0, 1_000)
    f.geometry.height = 800
    revealElementInScrollContainer(f.container, f.element, 'smooth', f.markScroll)
    expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 966, behavior: 'smooth' })
    const target = createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)!
    f.geometry.height = 900
    target.retarget(f.markScroll)
    expect(f.scrollTo).toHaveBeenCalledOnce()
    f.container.scrollTop = 401
    target.retarget(f.markScroll)
    expect(f.scrollTo).toHaveBeenCalledOnce()
    f.container.scrollTop = 966
    target.retarget(f.markScroll)
    expect(f.scrollTo).toHaveBeenLastCalledWith({ top: 966, behavior: 'auto' })
  })

  it.each(['growth', 'shrink'] as const)(
    'switches once to title alignment when live geometry becomes oversized (%s)',
    (change) => {
      const f = fixture(0, 1_000)
      if (change === 'shrink') {
        f.geometry.height = 500
      }
      const target = createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)!
      f.container.scrollTop = 401
      if (change === 'growth') {
        f.geometry.height = 800
      } else {
        Object.defineProperty(f.container, 'clientHeight', { value: 450 })
      }
      target.retarget(f.markScroll)
      expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 966, behavior: 'smooth' })
      f.geometry.height = 100
      target.retarget(f.markScroll)
      expect(f.scrollTo).toHaveBeenCalledOnce()
    }
  )

  it.each([false, true])(
    'does not accept an initially clipped oversized title (measured title: %s)',
    (measured) => {
      const f = fixture(0, 599)
      f.geometry.height = 800
      if (measured) {
        const title = document.createElement('span')
        title.dataset.worktreeTitleInlineRename = ''
        title.getBoundingClientRect = () => new DOMRect(0, 699, 200, 20)
        f.element.append(title)
      }
      revealElementInScrollContainer(f.container, f.element, 'smooth', f.markScroll)
      expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 565, behavior: 'smooth' })
    }
  )

  it('preserves an already readable measured title on an oversized card', () => {
    const f = fixture(0, 500)
    f.geometry.height = 800
    const title = document.createElement('span')
    title.dataset.worktreeTitleInlineRename = ''
    title.getBoundingClientRect = () => new DOMRect(0, 600, 200, 20)
    f.element.append(title)
    revealElementInScrollContainer(f.container, f.element, 'smooth', f.markScroll)
    expect(f.scrollTo).not.toHaveBeenCalled()
  })

  it('accumulates distant measurement drift without repeatedly restarting native easing', () => {
    const f = fixture()
    const target = createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 20)!
    f.container.scrollTop = 1_000
    target.retarget(f.markScroll)
    for (const top of [9_000, 8_000, 7_000]) {
      f.geometry.top = top
      target.retarget(f.markScroll)
    }
    expect(f.scrollTo).not.toHaveBeenCalled()
    f.container.scrollTop = 5_000
    target.retarget(f.markScroll)
    expect(f.markScroll).toHaveBeenCalledExactlyOnceWith(6_455)
    expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 6_455, behavior: 'smooth' })
    target.retarget(f.markScroll)
    expect(f.scrollTo).toHaveBeenCalledOnce()
    expect(target.retargetUntil).toBe(2_020)
  })

  it('retargets before one fast measurement frame can cross the viewport', () => {
    const f = fixture()
    const target = createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)!
    f.geometry.top = 7_000
    f.container.scrollTop = 3_500
    target.retarget(f.markScroll)
    expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 6_455, behavior: 'smooth' })
  })

  it('follows the end edge including height changes on a downward approach', () => {
    const f = fixture()
    const target = createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)!
    f.container.scrollTop = 8_000
    f.geometry.height = 155
    target.retarget(f.markScroll)
    expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 9_555, behavior: 'smooth' })
  })

  it.each([34, 70])(
    'preserves target clearance %i for nested upward reveals and retargets',
    (inset) => {
      const f = fixture(10_000, 5_000)
      const outer = document.createElement('div')
      outer.dataset.sidebarRevealTopInset = String(inset)
      f.container.append(outer)
      outer.append(f.element)
      revealElementInScrollContainer(f.container, f.element, 'smooth', f.markScroll)
      expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 5_000 - inset, behavior: 'smooth' })
      f.scrollTo.mockClear()
      const target = createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)!
      f.container.scrollTop = 7_000
      f.geometry.top = 6_000
      f.geometry.height = 155
      target.retarget(f.markScroll)
      expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 6_000 - inset, behavior: 'smooth' })
    }
  )

  it('uses stacked target headers when deciding whether a card is oversized', () => {
    const f = fixture(0, 1_000)
    f.element.dataset.sidebarRevealTopInset = '70'
    f.geometry.height = 540
    revealElementInScrollContainer(f.container, f.element, 'smooth', f.markScroll)
    expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 930, behavior: 'smooth' })
  })

  it('does not retarget an unchanged destination or an already visible element', () => {
    const f = fixture()
    const target = createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)!
    f.container.scrollTop = 8_000
    target.retarget(f.markScroll)
    expect(f.scrollTo).not.toHaveBeenCalled()
    f.geometry.top = 8_100
    expect(createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)).toBeNull()
  })

  it.each(['auto', 'instant'] as const)('never animates a %s request', (behavior) => {
    const f = fixture()
    expect(createMountedRevealSmoothTarget(f.container, f.element, behavior, 0)).toBeNull()
  })

  it('honors reduced motion before creating an animated destination', () => {
    const f = fixture()
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
    expect(createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)).toBeNull()
  })

  it('stops at the current offset when a fast frame has already revealed the moved target', () => {
    const f = fixture()
    const target = createMountedRevealSmoothTarget(f.container, f.element, 'smooth', 0)!
    f.geometry.top = 7_100
    f.container.scrollTop = 7_000
    target.retarget(f.markScroll)
    expect(f.markScroll).toHaveBeenCalledExactlyOnceWith(7_000)
    expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 7_000, behavior: 'auto' })
  })
})
