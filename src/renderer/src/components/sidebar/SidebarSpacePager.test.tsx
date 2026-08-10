// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Swiper as SwiperInstance } from 'swiper'
import type { AppState } from '@/store'
import type { Space } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  setActiveSpace: vi.fn(),
  state: {} as Partial<AppState>,
  swiperProps: {} as Record<string, unknown>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(mocks.state)
}))

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => false
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

const SPACES: Space[] = ['a', 'b', 'c', 'd'].map((id) => ({
  id,
  name: id.toUpperCase(),
  emoji: null,
  createdAt: 0,
  updatedAt: 0
}))

type CapturedSwiperProps = {
  onActiveIndexChange: (swiper: SwiperInstance) => void
  onSwiper: (swiper: SwiperInstance) => void
  onTouchEnd: () => void
  onTouchStart: (swiper: SwiperInstance) => void
  mousewheel: {
    forceToAxis: boolean
    releaseOnEdges: boolean
    thresholdDelta: number
  }
  simulateTouch: boolean
  slidesPerGroup: number
  slidesPerView: number
  speed: number
}

function swiperProps(): CapturedSwiperProps {
  return mocks.swiperProps as unknown as CapturedSwiperProps
}

function setStore(activeSpaceId: string): void {
  mocks.state = {
    spaces: SPACES,
    activeSpaceId,
    setActiveSpace: mocks.setActiveSpace
  } as unknown as Partial<AppState>
}

function renderPager(activeSpaceId = 'b'): ReturnType<typeof render> {
  setStore(activeSpaceId)
  return render(
    <SidebarSpacePager scrollOffsetRef={{ current: 0 }} scrollAnchorRef={{ current: null }} />
  )
}

function renderedPages(): { id: string | null; inert: string | null }[] {
  return Array.from(document.querySelectorAll('[data-space-id]')).map((element) => ({
    id: element.getAttribute('data-space-id'),
    inert: element.getAttribute('data-inert')
  }))
}

function swiper(activeIndex = 1): SwiperInstance {
  return {
    activeIndex,
    destroyed: false,
    slideTo: vi.fn()
  } as unknown as SwiperInstance
}

describe('SidebarSpacePager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('uses one-page snapping for trackpad movement', () => {
    renderPager()

    expect(swiperProps()).toEqual(
      expect.objectContaining({
        slidesPerGroup: 1,
        slidesPerView: 1,
        speed: 180,
        simulateTouch: false,
        mousewheel: {
          forceToAxis: true,
          releaseOnEdges: true,
          thresholdDelta: 6
        }
      })
    )
  })

  it('caps a direct swipe at the adjacent Space', () => {
    renderPager()
    const instance = swiper()
    swiperProps().onTouchStart(instance)
    instance.activeIndex = 3

    act(() => swiperProps().onActiveIndexChange(instance))

    expect(instance.slideTo).toHaveBeenCalledWith(2, 180, false)
    expect(mocks.setActiveSpace).toHaveBeenCalledWith('c')
    expect(mocks.setActiveSpace).not.toHaveBeenCalledWith('d')
  })

  it('mounts only the active Space and its neighbours', () => {
    renderPager()

    expect(document.querySelectorAll('[data-slide]')).toHaveLength(4)
    expect(renderedPages()).toEqual([
      { id: 'a', inert: 'true' },
      { id: 'b', inert: 'false' },
      { id: 'c', inert: 'true' }
    ])
  })

  it('activates a Space as soon as Swiper crosses into its slide', () => {
    renderPager()

    act(() => swiperProps().onActiveIndexChange(swiper(2)))

    expect(mocks.setActiveSpace).toHaveBeenCalledWith('c')
  })

  it('slides adjacent switcher and shortcut transitions', () => {
    renderPager()
    const instance = swiper()
    act(() => swiperProps().onSwiper(instance))

    expect(requestAnimatedSpaceTransition('c')).toBe(true)
    expect(instance.slideTo).toHaveBeenCalledWith(2, 180)
  })

  it('switches distant Spaces immediately instead of sweeping through empty slides', () => {
    renderPager()
    const instance = swiper()
    act(() => swiperProps().onSwiper(instance))

    expect(requestAnimatedSpaceTransition('d')).toBe(true)
    expect(instance.slideTo).toHaveBeenCalledWith(3, 0)
  })

  it('declines a transition to the active slide', () => {
    renderPager()
    act(() => swiperProps().onSwiper(swiper()))

    expect(requestAnimatedSpaceTransition('b')).toBe(false)
  })

  it('synchronizes an externally activated Space without another animation', () => {
    const view = renderPager()
    const instance = swiper()
    act(() => swiperProps().onSwiper(instance))

    setStore('d')
    view.rerender(
      <SidebarSpacePager scrollOffsetRef={{ current: 0 }} scrollAnchorRef={{ current: null }} />
    )

    expect(instance.slideTo).toHaveBeenCalledWith(3, 0, false)
  })
})
