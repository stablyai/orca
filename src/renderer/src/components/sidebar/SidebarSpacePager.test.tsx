// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Swiper as SwiperInstance } from 'swiper'
import type { AppState } from '@/store'
import type { Space } from '../../../../shared/types'

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  return {
    listeners,
    prefersReducedMotion: false,
    setActiveSpace: vi.fn(),
    state: {} as Partial<AppState>,
    swiperProps: {} as Record<string, unknown>,
    notify: (): void => {
      listeners.forEach((listener) => listener())
    }
  }
})

vi.mock('@/store', async () => {
  const react = await import('react')
  return {
    useAppStore: (selector: (state: Partial<AppState>) => unknown) =>
      react.useSyncExternalStore(
        (listener: () => void) => {
          mocks.listeners.add(listener)
          return () => mocks.listeners.delete(listener)
        },
        () => selector(mocks.state)
      )
  }
})

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => mocks.prefersReducedMotion
}))

vi.mock('swiper/react', () => ({
  Swiper: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => {
    mocks.swiperProps = props
    return <div data-swiper>{children}</div>
  },
  SwiperSlide: ({ children }: React.PropsWithChildren) => <div data-slide>{children}</div>
}))

vi.mock('./WorktreeList', () => ({
  default: ({ spaceId, inert }: { spaceId: string; inert?: boolean }) => (
    <div data-space-id={spaceId} data-inert={String(!!inert)} />
  )
}))

import SidebarSpacePager from './SidebarSpacePager'
import { requestAnimatedSpaceTransition } from './space-transition-controller'

function makeSpaces(ids: string[]): Space[] {
  return ids.map((id) => ({ id, name: id.toUpperCase(), emoji: null, createdAt: 0, updatedAt: 0 }))
}

const SPACES = makeSpaces(['a', 'b', 'c', 'd'])
const SIX_SPACES = makeSpaces(['a', 'b', 'c', 'd', 'e', 'f'])

type CapturedSwiperProps = {
  loop: boolean
  mousewheel: { forceToAxis: boolean; thresholdDelta: number }
  onActiveIndexChange: (swiper: SwiperInstance) => void
  onSwiper: (swiper: SwiperInstance) => void
  onTransitionStart: () => void
  onTransitionEnd: () => void
  simulateTouch: boolean
  slidesPerGroup: number
  slidesPerView: number
  speed: number
}

function swiperProps(): CapturedSwiperProps {
  return mocks.swiperProps as unknown as CapturedSwiperProps
}

function setStore(activeSpaceId: string, spaces: Space[] = SPACES): void {
  mocks.state = {
    spaces,
    activeSpaceId,
    setActiveSpace: mocks.setActiveSpace
  } as unknown as Partial<AppState>
  mocks.notify()
}

function renderPager(activeSpaceId = 'b', spaces: Space[] = SPACES): ReturnType<typeof render> {
  setStore(activeSpaceId, spaces)
  return render(
    <SidebarSpacePager scrollOffsetRef={{ current: 0 }} scrollAnchorRef={{ current: null }} />
  )
}

/** The Space rendered in each Swiper slot, in slot order; null where nothing is mounted. */
function slotContents(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-slide]')).map(
    (slide) => slide.querySelector('[data-space-id]')?.getAttribute('data-space-id') ?? null
  )
}

function inertBySpaceId(): Record<string, string | null> {
  return Object.fromEntries(
    Array.from(document.querySelectorAll('[data-space-id]')).map((element) => [
      element.getAttribute('data-space-id'),
      element.getAttribute('data-inert')
    ])
  )
}

type StatefulSwiper = SwiperInstance & { path: number[] }

/** Mirrors Swiper's loop stepping so tests can assert the route actually taken. */
function swiper(realIndex = 1, count = SPACES.length): StatefulSwiper {
  const instance = {
    activeIndex: realIndex,
    realIndex,
    destroyed: false,
    path: [realIndex],
    slideToLoop: vi.fn((index: number) => {
      instance.realIndex = index
      instance.activeIndex = index
      instance.path.push(index)
    }),
    slideNext: vi.fn(() => {
      instance.realIndex = (instance.realIndex + 1) % count
      instance.activeIndex = instance.realIndex
      instance.path.push(instance.realIndex)
    }),
    slidePrev: vi.fn(() => {
      instance.realIndex = (instance.realIndex - 1 + count) % count
      instance.activeIndex = instance.realIndex
      instance.path.push(instance.realIndex)
    })
  }
  return instance as unknown as StatefulSwiper
}

function attach(instance: StatefulSwiper): void {
  act(() => swiperProps().onSwiper(instance))
}

/** The mock's container stands in for `swiper.el`, which the pager listens on for pointer intent. */
function pagerElement(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-swiper]') as HTMLElement
}

function swiperWithElement(container: HTMLElement): StatefulSwiper {
  return Object.assign(swiper(0), { el: pagerElement(container) }) as StatefulSwiper
}

function transitionTo(spaceId: string): boolean {
  let handled = false
  act(() => {
    handled = requestAnimatedSpaceTransition(spaceId)
  })
  return handled
}

describe('SidebarSpacePager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.prefersReducedMotion = false
    mocks.setActiveSpace.mockImplementation((spaceId: string) => {
      setStore(spaceId, (mocks.state.spaces ?? SPACES) as Space[])
    })
  })

  afterEach(() => {
    cleanup()
    mocks.listeners.clear()
    vi.useRealTimers()
  })

  it('uses one-page snapping with circular navigation', () => {
    renderPager()

    expect(swiperProps()).toEqual(
      expect.objectContaining({
        loop: true,
        slidesPerGroup: 1,
        slidesPerView: 1,
        speed: 180,
        simulateTouch: false,
        mousewheel: { forceToAxis: true, thresholdDelta: 6 }
      })
    )
  })

  it('mounts only the active Space while the strip is idle and unpointed', () => {
    renderPager('a')

    expect(document.querySelectorAll('[data-slide]')).toHaveLength(4)
    expect(slotContents()).toEqual(['a', null, null, null])
    expect(inertBySpaceId()).toEqual({ a: 'false' })
  })

  it('brings neighbours back while a slide runs, so a swipe never reveals an empty page', () => {
    // Why: a wheel swipe moves the strip with no travel to pin the outgoing slot, so without this
    // the Space being swiped away unmounts the moment activeSpaceId changes and blanks mid-slide.
    renderPager('a')

    act(() => swiperProps().onTransitionStart())
    expect(slotContents()).toEqual(['a', 'b', null, 'd'])

    act(() => swiperProps().onTransitionEnd())
    expect(slotContents()).toEqual(['a', null, null, null])
  })

  it('pre-mounts neighbours while the pointer rests on the strip', () => {
    // Why: Swiper starts its slide inside its own wheel handler, so a neighbour mounted on that
    // event lands mid-animation — pointing at the strip is the earliest signal a swipe may follow.
    const { container } = renderPager('a')
    act(() => swiperProps().onSwiper(swiperWithElement(container)))

    act(() => {
      pagerElement(container).dispatchEvent(new Event('pointerenter'))
    })
    expect(slotContents()).toEqual(['a', 'b', null, 'd'])

    act(() => {
      pagerElement(container).dispatchEvent(new Event('pointerleave'))
    })
    expect(slotContents()).toEqual(['a', null, null, null])
  })

  it('activates the Space its Swiper slot is showing', () => {
    renderPager()
    attach(swiper())

    act(() => swiperProps().onActiveIndexChange(swiper(2)))

    expect(mocks.setActiveSpace).toHaveBeenCalledWith('c')
  })

  it('wraps from the last Space to the first', () => {
    renderPager('d')
    attach(swiper(3))

    act(() => swiperProps().onActiveIndexChange(swiper(0)))

    expect(mocks.setActiveSpace).toHaveBeenCalledWith('a')
  })

  it('slides forward to a Space that sits further right', () => {
    // Why: c -> d is one step forward; slideToLoop used to run it backwards through b and a.
    renderPager('c')
    const instance = swiper(2)
    attach(instance)

    expect(transitionTo('d')).toBe(true)
    expect(instance.slideNext).toHaveBeenCalledWith(180)
    expect(instance.slidePrev).not.toHaveBeenCalled()
    expect(instance.path).toEqual([2, 3])
    expect(instance.slideToLoop).not.toHaveBeenCalled()
  })

  it('slides back to the first Space rather than wrapping forward past the end', () => {
    // Why: the strip shows a as the leftmost dot, so reaching it has to travel left even from d.
    renderPager('d')
    const instance = swiper(3)
    attach(instance)

    expect(transitionTo('a')).toBe(true)
    expect(instance.slidePrev).toHaveBeenCalledWith(180)
    expect(instance.slideNext).not.toHaveBeenCalled()
    expect(instance.path).toEqual([3, 2])
    expect(slotContents()).toEqual([null, null, 'a', 'd'])
  })

  it('reaches a distant Space in a single slide, showing only the two Spaces involved', () => {
    renderPager('b', SIX_SPACES)
    const instance = swiper(1, SIX_SPACES.length)
    attach(instance)

    expect(transitionTo('e')).toBe(true)

    // One slide: b holds still in its own slot while e — three Spaces away — slides in next to it.
    expect(instance.slideNext).toHaveBeenCalledTimes(1)
    expect(instance.slideNext).toHaveBeenCalledWith(180)
    expect(instance.path).toEqual([1, 2])
    expect(slotContents()).toEqual([null, 'b', 'e', null, null, null])
    expect(mocks.setActiveSpace).toHaveBeenCalledTimes(1)
    expect(mocks.setActiveSpace).toHaveBeenCalledWith('e')
  })

  it('slides backwards when the target Space sits to the left', () => {
    renderPager('e', SIX_SPACES)
    const instance = swiper(4, SIX_SPACES.length)
    attach(instance)

    expect(transitionTo('b')).toBe(true)

    expect(instance.slidePrev).toHaveBeenCalledTimes(1)
    expect(instance.slideNext).not.toHaveBeenCalled()
    expect(instance.path).toEqual([4, 3])
    expect(slotContents()).toEqual([null, null, null, 'b', 'e', null])
  })

  it('follows the strip rather than the shorter way round the loop', () => {
    // Why: b -> f is one step backwards around the loop, but f is the rightmost dot in the strip.
    renderPager('b', SIX_SPACES)
    const instance = swiper(1, SIX_SPACES.length)
    attach(instance)

    expect(transitionTo('f')).toBe(true)

    expect(instance.slideNext).toHaveBeenCalledTimes(1)
    expect(instance.slidePrev).not.toHaveBeenCalled()
    expect(instance.path).toEqual([1, 2])
    expect(slotContents()).toEqual([null, 'b', 'f', null, null, null])
  })

  it('releases the outgoing Space once the slide has finished', () => {
    renderPager('b', SIX_SPACES)
    const instance = swiper(1, SIX_SPACES.length)
    attach(instance)
    expect(transitionTo('e')).toBe(true)

    act(() => {
      vi.advanceTimersByTime(500)
    })

    // The slot that held b during the slide is released, leaving only the arrived Space mounted.
    expect(slotContents()).toEqual([null, null, 'e', null, null, null])
    expect(instance.path).toEqual([1, 2])
  })

  it('keeps mapping Swiper slots to Spaces after a jump has re-anchored them', () => {
    renderPager('b', SIX_SPACES)
    const instance = swiper(1, SIX_SPACES.length)
    attach(instance)
    expect(transitionTo('e')).toBe(true)
    act(() => {
      vi.advanceTimersByTime(500)
    })

    act(() => swiperProps().onActiveIndexChange(swiper(3, SIX_SPACES.length)))

    expect(mocks.setActiveSpace).toHaveBeenLastCalledWith('f')
  })

  it('reaches every other Space in exactly one slide, in the direction the strip reads', () => {
    const count = SIX_SPACES.length

    for (let from = 0; from < count; from++) {
      for (let to = 0; to < count; to++) {
        if (from === to) {
          continue
        }
        cleanup()
        renderPager(SIX_SPACES[from].id, SIX_SPACES)
        const instance = swiper(from, count)
        attach(instance)

        expect(transitionTo(SIX_SPACES[to].id)).toBe(true)

        const step = to < from ? -1 : 1
        const destination = (from + step + count) % count
        expect({ from, to, path: instance.path }).toEqual({ from, to, path: [from, destination] })
        expect(slotContents()[destination]).toBe(SIX_SPACES[to].id)
        act(() => {
          vi.advanceTimersByTime(500)
        })
      }
    }
  })

  it('shows the outgoing Space once when the hop spans the whole strip', () => {
    // Why: f -> a rotates f onto a second slot next to the target while its pin still holds it.
    renderPager('f', SIX_SPACES)
    const instance = swiper(5, SIX_SPACES.length)
    attach(instance)

    expect(transitionTo('a')).toBe(true)

    expect(instance.path).toEqual([5, 4])
    expect(slotContents()).toEqual([null, null, null, null, 'a', 'f'])
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(slotContents()).toEqual([null, null, null, null, 'a', null])
  })

  it('chains a second jump without stranding the first', () => {
    renderPager('a', SIX_SPACES)
    const instance = swiper(0, SIX_SPACES.length)
    attach(instance)

    expect(transitionTo('c')).toBe(true)
    expect(transitionTo('e')).toBe(true)

    expect(instance.path).toEqual([0, 1, 2])
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(slotContents()[2]).toBe('e')
    expect(mocks.setActiveSpace).toHaveBeenLastCalledWith('e')
  })

  it('shows the arriving Space when jumps chain past a slot an earlier hop pinned', () => {
    // Why: the pin from a -> c held slot 0; without releasing it, the third hop slid back into
    // slot 0 and kept rendering that stale Space while activeSpaceId had already moved on.
    renderPager('a', SIX_SPACES)
    const instance = swiper(0, SIX_SPACES.length)
    attach(instance)

    expect(transitionTo('c')).toBe(true)
    expect(transitionTo('d')).toBe(true)
    expect(transitionTo('a')).toBe(true)

    expect(slotContents()[instance.realIndex]).toBe('a')
    expect(mocks.setActiveSpace).toHaveBeenLastCalledWith('a')
  })

  it('leaves the switch to the caller when reduced motion is preferred', () => {
    mocks.prefersReducedMotion = true
    renderPager()
    const instance = swiper()
    attach(instance)

    expect(requestAnimatedSpaceTransition('d')).toBe(false)
    expect(instance.slideNext).not.toHaveBeenCalled()
    expect(instance.slidePrev).not.toHaveBeenCalled()
  })

  it('declines a transition to the active Space', () => {
    renderPager()
    attach(swiper())

    expect(requestAnimatedSpaceTransition('b')).toBe(false)
  })

  it('synchronizes an externally activated Space without animation', () => {
    renderPager()
    const instance = swiper()
    attach(instance)

    act(() => setStore('d'))

    expect(instance.slideToLoop).toHaveBeenCalledWith(3, 0, false)
  })
})
