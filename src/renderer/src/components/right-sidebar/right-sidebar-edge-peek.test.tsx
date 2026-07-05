// @vitest-environment happy-dom

import { act, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  PEEK_CLOSE_DELAY_MS,
  PEEK_OPEN_DELAY_MS,
  RightSidebarEdgePeekZone,
  useRightSidebarEdgePeekDismiss
} from './right-sidebar-edge-peek'

const initialAppState = useAppStore.getInitialState()

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  useAppStore.setState(initialAppState, true)
})

function makeOverlayRef(left: number): React.RefObject<HTMLElement | null> {
  return makeMovingOverlayRef(() => left)
}

// Overlay whose measured left edge changes between reads (e.g. the slide-in
// entrance transform still translating the panel when first measured).
function makeMovingOverlayRef(readLeft: () => number): React.RefObject<HTMLElement | null> {
  return {
    current: { getBoundingClientRect: () => ({ left: readLeft() }) } as unknown as HTMLElement
  }
}

const RIGHT_EDGE_X = window.innerWidth - 1
const BELOW_TITLEBAR_Y = 100

function moveMouse(clientX: number, clientY: number): void {
  act(() => {
    fireEvent.mouseMove(window, { clientX, clientY })
  })
}

describe('RightSidebarEdgePeekZone', () => {
  it('renders nothing (no DOM strip that could swallow edge clicks)', () => {
    const { container } = render(<RightSidebarEdgePeekZone />)
    expect(container.firstElementChild).toBeNull()
  })

  it('arms the peek after the pointer hovers the right edge for the open delay', () => {
    render(<RightSidebarEdgePeekZone />)

    moveMouse(RIGHT_EDGE_X, BELOW_TITLEBAR_Y)
    expect(useAppStore.getState().rightSidebarPeek).toBe(false)

    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    expect(useAppStore.getState().rightSidebarPeek).toBe(true)
  })

  it('cancels an armed peek when the pointer leaves the edge before the delay', () => {
    render(<RightSidebarEdgePeekZone />)

    moveMouse(RIGHT_EDGE_X, BELOW_TITLEBAR_Y)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS - 1)
    moveMouse(RIGHT_EDGE_X - 200, BELOW_TITLEBAR_Y)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)

    expect(useAppStore.getState().rightSidebarPeek).toBe(false)
  })

  it('ignores the top titlebar zone so window controls stay clickable', () => {
    render(<RightSidebarEdgePeekZone />)

    moveMouse(RIGHT_EDGE_X, 10)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)

    expect(useAppStore.getState().rightSidebarPeek).toBe(false)
  })

  it('does not arm while the sidebar is already open', () => {
    useAppStore.setState({ rightSidebarOpen: true })
    render(<RightSidebarEdgePeekZone />)

    moveMouse(RIGHT_EDGE_X, BELOW_TITLEBAR_Y)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)

    expect(useAppStore.getState().rightSidebarPeek).toBe(false)
  })

  it('clears an active peek when the zone unmounts on a view change', () => {
    const { unmount } = render(<RightSidebarEdgePeekZone />)

    moveMouse(RIGHT_EDGE_X, BELOW_TITLEBAR_Y)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    expect(useAppStore.getState().rightSidebarPeek).toBe(true)

    unmount()

    // A surviving flag would render a ghost peek when the user returns to a
    // sidebar-capable view.
    expect(useAppStore.getState().rightSidebarPeek).toBe(false)
  })

  it('clears an armed timer if the sidebar opens before it fires', () => {
    const { rerender } = render(<RightSidebarEdgePeekZone />)

    moveMouse(RIGHT_EDGE_X, BELOW_TITLEBAR_Y)
    act(() => {
      useAppStore.setState({ rightSidebarOpen: true })
    })
    rerender(<RightSidebarEdgePeekZone />)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)

    // The pending open timer must not flip peek on after the sidebar opened.
    expect(useAppStore.getState().rightSidebarPeek).toBe(false)
  })
})

describe('useRightSidebarEdgePeekDismiss', () => {
  it('dismisses after the pointer stays left of the overlay for the close delay', () => {
    const setPeek = vi.fn()
    renderHook(() =>
      useRightSidebarEdgePeekDismiss({
        isPeeking: true,
        isResizing: false,
        setPeek,
        overlayRef: makeOverlayRef(1000)
      })
    )

    fireEvent.mouseMove(window, { clientX: 400 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)

    expect(setPeek).toHaveBeenCalledWith(false)
  })

  it('keeps the peek when the pointer returns to the overlay before the delay', () => {
    const setPeek = vi.fn()
    renderHook(() =>
      useRightSidebarEdgePeekDismiss({
        isPeeking: true,
        isResizing: false,
        setPeek,
        overlayRef: makeOverlayRef(1000)
      })
    )

    fireEvent.mouseMove(window, { clientX: 400 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS - 1)
    fireEvent.mouseMove(window, { clientX: 1100 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)

    expect(setPeek).not.toHaveBeenCalled()
  })

  it('does not dismiss when the boundary was measured mid entrance animation', () => {
    const setPeek = vi.fn()
    // First read happens during the slide-in: the overlay still sits near the
    // window's right edge. By the time the close timer re-measures, the
    // animation has settled at its real position.
    let overlayLeft = 1590
    renderHook(() =>
      useRightSidebarEdgePeekDismiss({
        isPeeking: true,
        isResizing: false,
        setPeek,
        overlayRef: makeMovingOverlayRef(() => overlayLeft)
      })
    )

    // The pointer moves into the settled overlay area (left of the stale
    // mid-animation boundary), which schedules a close against stale geometry.
    fireEvent.mouseMove(window, { clientX: 1200 })
    overlayLeft = 1000
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)

    // The re-measure inside the close timer sees the settled boundary and
    // keeps the peek open.
    expect(setPeek).not.toHaveBeenCalled()

    // The refreshed cache now classifies the same position as inside.
    fireEvent.mouseMove(window, { clientX: 1200 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)
    expect(setPeek).not.toHaveBeenCalled()

    // A genuine exit still dismisses.
    fireEvent.mouseMove(window, { clientX: 400 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)
    expect(setPeek).toHaveBeenCalledWith(false)
  })

  it('does not dismiss while a resize drag travels past the overlay edge', () => {
    const setPeek = vi.fn()
    renderHook(() =>
      useRightSidebarEdgePeekDismiss({
        isPeeking: true,
        isResizing: true,
        setPeek,
        overlayRef: makeOverlayRef(1000)
      })
    )

    fireEvent.mouseMove(window, { clientX: 100 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)

    expect(setPeek).not.toHaveBeenCalled()
  })

  it('dismisses immediately when the window loses focus', () => {
    const setPeek = vi.fn()
    renderHook(() =>
      useRightSidebarEdgePeekDismiss({
        isPeeking: true,
        isResizing: false,
        setPeek,
        overlayRef: makeOverlayRef(1000)
      })
    )

    fireEvent.blur(window)

    expect(setPeek).toHaveBeenCalledWith(false)
  })
})
