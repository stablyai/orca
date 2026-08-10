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

function dispatchWheel(target: Element, deltaX: number, deltaY: number): WheelEvent {
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
    mocks.state = {
      spaces: SPACES,
      activeSpaceId: 'b',
      setActiveSpace: mocks.setActiveSpace
    } as unknown as Partial<AppState>
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

  it('moves exactly one Space for a horizontal wheel gesture', () => {
    const { container } = render(
      <SidebarSpacePager scrollOffsetRef={{ current: 0 }} scrollAnchorRef={{ current: null }} />
    )
    const swiper = container.querySelector('.swiper') as HTMLElement
    const wrapper = container.querySelector('.swiper-wrapper') as HTMLElement
    act(() => vi.advanceTimersByTime(61))

    const event = dispatchWheel(swiper, 2_000, 0)
    const continuedGesture = dispatchWheel(swiper, 2_000, 0)

    expect(event.defaultPrevented).toBe(true)
    expect(continuedGesture.defaultPrevented).toBe(true)
    expect(wrapper.style.transform).toContain('-600px')
    expect(mocks.setActiveSpace).toHaveBeenCalledWith('c')
    expect(mocks.setActiveSpace).not.toHaveBeenCalledWith('d')
  })

  it('leaves vertical wheel movement to the workspace list', () => {
    const { container } = render(
      <SidebarSpacePager scrollOffsetRef={{ current: 0 }} scrollAnchorRef={{ current: null }} />
    )
    const swiper = container.querySelector('.swiper') as HTMLElement

    const event = dispatchWheel(swiper, 2, 40)

    expect(event.defaultPrevented).toBe(false)
    expect(mocks.setActiveSpace).not.toHaveBeenCalled()
  })

  it('reverses direction after the current one-page snap without requiring focus', () => {
    const { container } = render(
      <SidebarSpacePager scrollOffsetRef={{ current: 0 }} scrollAnchorRef={{ current: null }} />
    )
    const swiper = container.querySelector('.swiper') as HTMLElement
    const wrapper = container.querySelector('.swiper-wrapper') as HTMLElement
    act(() => vi.advanceTimersByTime(61))

    dispatchWheel(swiper, 2_000, 0)
    act(() => wrapper.dispatchEvent(new Event('transitionend', { bubbles: true })))
    act(() => vi.advanceTimersByTime(61))
    const reverseEvent = dispatchWheel(swiper, -2_000, 0)

    expect(reverseEvent.defaultPrevented).toBe(true)
    expect(wrapper.style.transform).toContain('-300px')
    expect(mocks.setActiveSpace).toHaveBeenCalledWith('c')
    expect(mocks.setActiveSpace).toHaveBeenCalledWith('b')
  })

  it('accepts consecutive gestures in the same direction', () => {
    const { container } = render(
      <SidebarSpacePager scrollOffsetRef={{ current: 0 }} scrollAnchorRef={{ current: null }} />
    )
    const swiper = container.querySelector('.swiper') as HTMLElement
    const wrapper = container.querySelector('.swiper-wrapper') as HTMLElement
    act(() => vi.advanceTimersByTime(61))

    dispatchWheel(swiper, 2_000, 0)
    act(() => wrapper.dispatchEvent(new Event('transitionend', { bubbles: true })))
    act(() => vi.advanceTimersByTime(151))
    const secondGesture = dispatchWheel(swiper, 2_000, 0)

    expect(secondGesture.defaultPrevented).toBe(true)
    expect(wrapper.style.transform).toContain('-900px')
    expect(mocks.setActiveSpace).toHaveBeenCalledWith('c')
    expect(mocks.setActiveSpace).toHaveBeenCalledWith('d')
  })
})
