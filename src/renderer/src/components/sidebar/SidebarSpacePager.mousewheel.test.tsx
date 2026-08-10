// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { Space } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  setActiveSpace: vi.fn(),
  state: {} as Partial<AppState>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(mocks.state)
}))

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => false
}))

vi.mock('./WorktreeList', () => ({
  default: ({ spaceId }: { spaceId: string }) => <div data-space-id={spaceId} />
}))

import SidebarSpacePager from './SidebarSpacePager'

const SPACES: Space[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
  id,
  name: id.toUpperCase(),
  emoji: null,
  createdAt: 0,
  updatedAt: 0
}))

function setStore(activeSpaceId: string): void {
  mocks.state = {
    spaces: SPACES,
    activeSpaceId,
    setActiveSpace: mocks.setActiveSpace
  } as unknown as Partial<AppState>
}

function renderPager(activeSpaceId: string): ReturnType<typeof render> {
  setStore(activeSpaceId)
  const view = render(
    <SidebarSpacePager scrollOffsetRef={{ current: 0 }} scrollAnchorRef={{ current: null }} />
  )
  act(() => vi.advanceTimersByTime(61))
  return view
}

function dispatchWheel(target: Element, deltaX: number, deltaY = 0): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaX,
    deltaY
  })
  act(() => target.dispatchEvent(event))
  return event
}

describe('SidebarSpacePager mousewheel integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperties(HTMLElement.prototype, {
      clientHeight: { configurable: true, get: () => 500 },
      clientWidth: { configurable: true, get: () => 300 }
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
    Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
    vi.clearAllMocks()
  })

  it('moves only one Space during one wheel transition', () => {
    const { container } = renderPager('b')
    const swiper = container.querySelector('.swiper') as HTMLElement

    dispatchWheel(swiper, 2_000)
    dispatchWheel(swiper, 2_000)

    expect(mocks.setActiveSpace).toHaveBeenCalledWith('c')
    expect(mocks.setActiveSpace).not.toHaveBeenCalledWith('d')
  })

  it('accepts consecutive forward gestures after each one-page transition', () => {
    const { container } = renderPager('b')
    const swiper = container.querySelector('.swiper') as HTMLElement
    const wrapper = container.querySelector('.swiper-wrapper') as HTMLElement

    dispatchWheel(swiper, 2_000)
    act(() => wrapper.dispatchEvent(new Event('transitionend', { bubbles: true })))
    act(() => vi.advanceTimersByTime(151))
    dispatchWheel(swiper, 2_000)

    expect(mocks.setActiveSpace).toHaveBeenCalledWith('c')
    expect(mocks.setActiveSpace).toHaveBeenCalledWith('d')
  })

  it('wraps forward from the last Space to the first', () => {
    const { container } = renderPager('e')
    const swiper = container.querySelector('.swiper') as HTMLElement

    dispatchWheel(swiper, 2_000)

    expect(mocks.setActiveSpace).toHaveBeenLastCalledWith('a')
  })

  it('wraps backward from the first Space to the last', () => {
    const { container } = renderPager('a')
    const swiper = container.querySelector('.swiper') as HTMLElement

    dispatchWheel(swiper, -2_000)

    expect(mocks.setActiveSpace).toHaveBeenLastCalledWith('e')
  })

  it('leaves vertical scrolling to the workspace list', () => {
    const { container } = renderPager('b')
    const swiper = container.querySelector('.swiper') as HTMLElement

    const event = dispatchWheel(swiper, 2, 40)

    expect(event.defaultPrevented).toBe(false)
    expect(mocks.setActiveSpace).not.toHaveBeenCalled()
  })
})
