// @vitest-environment happy-dom

import { act, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  PEEK_CLOSE_DELAY_MS,
  PEEK_OPEN_DELAY_MS,
  LeftSidebarEdgePeekZone,
  useLeftSidebarEdgePeekDismiss
} from './left-sidebar-edge-peek'

const initialAppState = useAppStore.getInitialState()

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState({ sidebarOpen: false, sidebarPeek: false })
})

afterEach(() => {
  vi.useRealTimers()
  useAppStore.setState(initialAppState, true)
})

function makeOverlayRef(right: number): React.RefObject<HTMLElement | null> {
  return makeMovingOverlayRef(() => right)
}

// Overlay whose measured right edge changes between reads (e.g. the slide-in
// entrance transform still translating the panel when first measured).
function makeMovingOverlayRef(readRight: () => number): React.RefObject<HTMLElement | null> {
  return {
    current: { getBoundingClientRect: () => ({ right: readRight() }) } as unknown as HTMLElement
  }
}

const LEFT_EDGE_X = 1
const BELOW_TITLEBAR_Y = 100

function moveMouse(clientX: number, clientY: number, buttons = 0): void {
  act(() => {
    fireEvent.mouseMove(window, { clientX, clientY, buttons })
  })
}

describe('LeftSidebarEdgePeekZone', () => {
  it('renders nothing (no DOM strip that could swallow edge clicks)', () => {
    const { container } = render(<LeftSidebarEdgePeekZone />)
    expect(container.firstElementChild).toBeNull()
  })

  it('arms the peek after the pointer hovers the left edge for the open delay', () => {
    render(<LeftSidebarEdgePeekZone />)

    moveMouse(LEFT_EDGE_X, BELOW_TITLEBAR_Y)
    expect(useAppStore.getState().sidebarPeek).toBe(false)

    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    expect(useAppStore.getState().sidebarPeek).toBe(true)
  })

  it('cancels an armed peek when the pointer leaves the edge before the delay', () => {
    render(<LeftSidebarEdgePeekZone />)

    moveMouse(LEFT_EDGE_X, BELOW_TITLEBAR_Y)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS - 1)
    moveMouse(LEFT_EDGE_X + 200, BELOW_TITLEBAR_Y)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)

    expect(useAppStore.getState().sidebarPeek).toBe(false)
  })

  it('ignores the top titlebar zone so window controls stay clickable', () => {
    render(<LeftSidebarEdgePeekZone />)

    moveMouse(LEFT_EDGE_X, 10)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)

    expect(useAppStore.getState().sidebarPeek).toBe(false)
  })

  it('does not arm while a mouse button is held (drag near the edge)', () => {
    render(<LeftSidebarEdgePeekZone />)

    moveMouse(LEFT_EDGE_X, BELOW_TITLEBAR_Y, 1)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)

    expect(useAppStore.getState().sidebarPeek).toBe(false)
  })

  it('does not arm while the sidebar is already open', () => {
    useAppStore.setState({ sidebarOpen: true })
    render(<LeftSidebarEdgePeekZone />)

    moveMouse(LEFT_EDGE_X, BELOW_TITLEBAR_Y)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)

    expect(useAppStore.getState().sidebarPeek).toBe(false)
  })

  it('clears an active peek when the zone unmounts on a view change', () => {
    const { unmount } = render(<LeftSidebarEdgePeekZone />)

    moveMouse(LEFT_EDGE_X, BELOW_TITLEBAR_Y)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    expect(useAppStore.getState().sidebarPeek).toBe(true)

    unmount()

    // A surviving flag would render a ghost peek when the user returns to a
    // sidebar-capable view.
    expect(useAppStore.getState().sidebarPeek).toBe(false)
  })

  it('clears an armed timer if the sidebar opens before it fires', () => {
    const { rerender } = render(<LeftSidebarEdgePeekZone />)

    moveMouse(LEFT_EDGE_X, BELOW_TITLEBAR_Y)
    act(() => {
      useAppStore.setState({ sidebarOpen: true })
    })
    rerender(<LeftSidebarEdgePeekZone />)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)

    // The pending open timer must not flip peek on after the sidebar opened.
    expect(useAppStore.getState().sidebarPeek).toBe(false)
  })
})

describe('useLeftSidebarEdgePeekDismiss', () => {
  it('dismisses after the pointer stays right of the overlay for the close delay', () => {
    const setPeek = vi.fn()
    renderHook(() =>
      useLeftSidebarEdgePeekDismiss({
        isPeeking: true,
        isResizing: false,
        setPeek,
        overlayRef: makeOverlayRef(280)
      })
    )

    fireEvent.mouseMove(window, { clientX: 400 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)

    expect(setPeek).toHaveBeenCalledWith(false)
  })

  it('keeps the peek when the pointer returns to the overlay before the delay', () => {
    const setPeek = vi.fn()
    renderHook(() =>
      useLeftSidebarEdgePeekDismiss({
        isPeeking: true,
        isResizing: false,
        setPeek,
        overlayRef: makeOverlayRef(280)
      })
    )

    fireEvent.mouseMove(window, { clientX: 400 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS - 1)
    fireEvent.mouseMove(window, { clientX: 100 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)

    expect(setPeek).not.toHaveBeenCalled()
  })

  it('does not dismiss when the boundary was measured mid entrance animation', () => {
    const setPeek = vi.fn()
    // First read happens during the slide-in: the overlay still sits near the
    // window's left edge. By the time the close timer re-measures, the
    // animation has settled at its real position.
    let overlayRight = 10
    renderHook(() =>
      useLeftSidebarEdgePeekDismiss({
        isPeeking: true,
        isResizing: false,
        setPeek,
        overlayRef: makeMovingOverlayRef(() => overlayRight)
      })
    )

    // The pointer moves into the settled overlay area (right of the stale
    // mid-animation boundary), which schedules a close against stale geometry.
    fireEvent.mouseMove(window, { clientX: 120 })
    overlayRight = 280
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)

    // The re-measure inside the close timer sees the settled boundary and
    // keeps the peek open.
    expect(setPeek).not.toHaveBeenCalled()

    // The refreshed cache now classifies the same position as inside.
    fireEvent.mouseMove(window, { clientX: 120 })
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
      useLeftSidebarEdgePeekDismiss({
        isPeeking: true,
        isResizing: true,
        setPeek,
        overlayRef: makeOverlayRef(280)
      })
    )

    fireEvent.mouseMove(window, { clientX: 600 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)

    expect(setPeek).not.toHaveBeenCalled()
  })

  it('dismisses immediately when the window loses focus', () => {
    const setPeek = vi.fn()
    renderHook(() =>
      useLeftSidebarEdgePeekDismiss({
        isPeeking: true,
        isResizing: false,
        setPeek,
        overlayRef: makeOverlayRef(280)
      })
    )

    fireEvent.blur(window)

    expect(setPeek).toHaveBeenCalledWith(false)
  })
})
