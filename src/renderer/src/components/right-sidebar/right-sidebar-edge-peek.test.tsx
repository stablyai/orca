// @vitest-environment happy-dom

import { act, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  PEEK_CLOSE_DELAY_MS,
  PEEK_GESTURE_SUPPRESS_MS,
  PEEK_OPEN_DELAY_MS,
  RightSidebarEdgePeekZone,
  isPointerOverVerticalScrollbar,
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

function renderDismissHook(args: {
  setPeek: (peek: boolean) => void
  isResizing?: boolean
  overlayRef?: React.RefObject<HTMLElement | null>
}): void {
  renderHook(() =>
    useRightSidebarEdgePeekDismiss({
      isPeeking: true,
      isResizing: args.isResizing ?? false,
      setPeek: args.setPeek,
      overlayRef: args.overlayRef ?? makeOverlayRef(1000)
    })
  )
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

  it('does not arm while a mouse button is pressed at the edge', () => {
    render(<RightSidebarEdgePeekZone />)

    act(() => {
      fireEvent.mouseMove(window, {
        clientX: RIGHT_EDGE_X,
        clientY: BELOW_TITLEBAR_Y,
        buttons: 1
      })
    })
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)

    expect(useAppStore.getState().rightSidebarPeek).toBe(false)
  })

  it('cancels an armed peek when a scrollbar drag starts', () => {
    render(<RightSidebarEdgePeekZone />)

    moveMouse(RIGHT_EDGE_X, BELOW_TITLEBAR_Y)
    fireEvent.mouseDown(window, { buttons: 1 })
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)

    expect(useAppStore.getState().rightSidebarPeek).toBe(false)
  })

  it('does not re-arm immediately after mouseup (scrollbar release cool-down)', () => {
    render(<RightSidebarEdgePeekZone />)

    moveMouse(RIGHT_EDGE_X, BELOW_TITLEBAR_Y)
    fireEvent.mouseDown(window, { buttons: 1 })
    fireEvent.mouseUp(window, { buttons: 0 })
    // Hover still on the edge after releasing a drag.
    moveMouse(RIGHT_EDGE_X, BELOW_TITLEBAR_Y)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    expect(useAppStore.getState().rightSidebarPeek).toBe(false)

    // After the cool-down, intentional edge hover can arm again.
    vi.advanceTimersByTime(PEEK_GESTURE_SUPPRESS_MS)
    moveMouse(RIGHT_EDGE_X, BELOW_TITLEBAR_Y)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    expect(useAppStore.getState().rightSidebarPeek).toBe(true)
  })

  it('does not arm while the pointer is over a vertical scrollbar gutter', () => {
    const scrollPort = document.createElement('div')
    Object.defineProperty(scrollPort, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scrollPort, 'clientHeight', { configurable: true, value: 400 })
    scrollPort.getBoundingClientRect = () =>
      ({
        top: 0,
        left: window.innerWidth - 20,
        right: window.innerWidth,
        bottom: 400,
        width: 20,
        height: 400,
        x: window.innerWidth - 20,
        y: 0,
        toJSON: () => ({})
      }) as DOMRect
    document.body.appendChild(scrollPort)
    const styleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      if (el === scrollPort) {
        return { overflowY: 'auto' } as CSSStyleDeclaration
      }
      return { overflowY: 'visible' } as CSSStyleDeclaration
    })

    render(<RightSidebarEdgePeekZone />)
    act(() => {
      fireEvent.mouseMove(scrollPort, {
        clientX: RIGHT_EDGE_X,
        clientY: BELOW_TITLEBAR_Y,
        buttons: 0,
        target: scrollPort
      })
    })
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    expect(useAppStore.getState().rightSidebarPeek).toBe(false)

    styleSpy.mockRestore()
    scrollPort.remove()
  })

  it('does not arm while the pointer is over a Monaco/custom scrollbar node', () => {
    const thumb = document.createElement('div')
    thumb.className = 'slider'
    const host = document.createElement('div')
    host.className = 'monaco-scrollable-element'
    host.appendChild(thumb)
    document.body.appendChild(host)

    render(<RightSidebarEdgePeekZone />)
    act(() => {
      fireEvent.mouseMove(thumb, {
        clientX: RIGHT_EDGE_X,
        clientY: BELOW_TITLEBAR_Y,
        buttons: 0
      })
    })
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    expect(useAppStore.getState().rightSidebarPeek).toBe(false)

    host.remove()
  })

  it('does not arm during wheel/scroll near the edge', () => {
    render(<RightSidebarEdgePeekZone />)

    act(() => {
      fireEvent.wheel(window, { clientX: RIGHT_EDGE_X, clientY: BELOW_TITLEBAR_Y })
    })
    moveMouse(RIGHT_EDGE_X, BELOW_TITLEBAR_Y)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    expect(useAppStore.getState().rightSidebarPeek).toBe(false)
  })

  it.each([
    ['the window loses focus', () => fireEvent.blur(window)],
    ['the pointer leaves the window', () => fireEvent.mouseLeave(document.documentElement)]
  ])('cancels an armed peek when %s', (_reason, leaveWindow) => {
    render(<RightSidebarEdgePeekZone />)

    moveMouse(RIGHT_EDGE_X, BELOW_TITLEBAR_Y)
    leaveWindow()
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

  it('does not arm when edge peek is disabled in settings', () => {
    useAppStore.setState({
      settings: { rightSidebarEdgePeekEnabled: false } as never
    })
    render(<RightSidebarEdgePeekZone />)

    moveMouse(RIGHT_EDGE_X, BELOW_TITLEBAR_Y)
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)

    expect(useAppStore.getState().rightSidebarPeek).toBe(false)
  })

  it('clears an active peek when edge peek is turned off', () => {
    useAppStore.setState({ rightSidebarPeek: true })
    const { rerender } = render(<RightSidebarEdgePeekZone />)
    expect(useAppStore.getState().rightSidebarPeek).toBe(true)

    act(() => {
      useAppStore.setState({
        settings: { rightSidebarEdgePeekEnabled: false } as never
      })
    })
    rerender(<RightSidebarEdgePeekZone />)

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

describe('isPointerOverVerticalScrollbar', () => {
  it('detects the classic overflow scrollbar gutter on the right of a scrollport', () => {
    const scrollPort = document.createElement('div')
    Object.defineProperty(scrollPort, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scrollPort, 'clientHeight', { configurable: true, value: 400 })
    scrollPort.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 100,
        right: 500,
        bottom: 400,
        width: 400,
        height: 400,
        x: 100,
        y: 0,
        toJSON: () => ({})
      }) as DOMRect
    document.body.appendChild(scrollPort)
    const styleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      if (el === scrollPort) {
        return { overflowY: 'scroll' } as CSSStyleDeclaration
      }
      return { overflowY: 'visible' } as CSSStyleDeclaration
    })

    const over = {
      target: scrollPort,
      clientX: 495,
      clientY: 100
    } as unknown as MouseEvent
    const notOver = {
      target: scrollPort,
      clientX: 200,
      clientY: 100
    } as unknown as MouseEvent

    expect(isPointerOverVerticalScrollbar(over)).toBe(true)
    expect(isPointerOverVerticalScrollbar(notOver)).toBe(false)

    styleSpy.mockRestore()
    scrollPort.remove()
  })
})

describe('useRightSidebarEdgePeekDismiss', () => {
  it('dismisses after the pointer stays left of the overlay for the close delay', () => {
    const setPeek = vi.fn()
    renderDismissHook({ setPeek })

    fireEvent.mouseMove(window, { clientX: 400 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)

    expect(setPeek).toHaveBeenCalledWith(false)
  })

  it('keeps the peek when the pointer returns to the overlay before the delay', () => {
    const setPeek = vi.fn()
    renderDismissHook({ setPeek })

    fireEvent.mouseMove(window, { clientX: 400 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS - 1)
    fireEvent.mouseMove(window, { clientX: 1100 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)

    expect(setPeek).not.toHaveBeenCalled()
  })

  it.each(['dropdown-menu-content', 'dialog-content'])(
    'keeps the peek while the pointer uses portaled %s',
    (portalSlot) => {
      const setPeek = vi.fn()
      const portalContent = document.createElement('div')
      portalContent.dataset.slot = portalSlot
      document.body.appendChild(portalContent)
      renderDismissHook({ setPeek })

      fireEvent.mouseMove(portalContent, { clientX: 400 })
      vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)
      expect(setPeek).not.toHaveBeenCalled()

      fireEvent.mouseMove(window, { clientX: 400 })
      vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)
      expect(setPeek).toHaveBeenCalledWith(false)
      portalContent.remove()
    }
  )

  it('does not dismiss when the boundary was measured mid entrance animation', () => {
    const setPeek = vi.fn()
    // First read happens during the slide-in: the overlay still sits near the
    // window's right edge. By the time the close timer re-measures, the
    // animation has settled at its real position.
    let overlayLeft = 1590
    const readOverlayLeft = vi.fn(() => overlayLeft)
    renderDismissHook({ setPeek, overlayRef: makeMovingOverlayRef(readOverlayLeft) })

    // The pointer moves into the settled overlay area (left of the stale
    // mid-animation boundary), which schedules a close against stale geometry.
    fireEvent.mouseMove(window, { clientX: 1200 })
    expect(readOverlayLeft).toHaveBeenCalledTimes(1)
    overlayLeft = 1000
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)

    // The re-measure inside the close timer sees the settled boundary and
    // keeps the peek open.
    expect(setPeek).not.toHaveBeenCalled()

    // The refreshed cache now classifies the same position as inside.
    fireEvent.mouseMove(window, { clientX: 1200 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)
    expect(readOverlayLeft).toHaveBeenCalledTimes(2)
    expect(setPeek).not.toHaveBeenCalled()

    // A genuine exit still dismisses.
    fireEvent.mouseMove(window, { clientX: 400 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)
    expect(setPeek).toHaveBeenCalledWith(false)
  })

  it('does not dismiss while a resize drag travels past the overlay edge', () => {
    const setPeek = vi.fn()
    renderDismissHook({ setPeek, isResizing: true })

    fireEvent.mouseMove(window, { clientX: 100 })
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)

    expect(setPeek).not.toHaveBeenCalled()
  })

  it.each([
    ['the window loses focus', () => fireEvent.blur(window)],
    ['the pointer leaves the window', () => fireEvent.mouseLeave(document.documentElement)]
  ])('dismisses immediately when %s', (_reason, leaveWindow) => {
    const setPeek = vi.fn()
    renderDismissHook({ setPeek })

    leaveWindow()

    expect(setPeek).toHaveBeenCalledWith(false)
  })
})
