// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { RightSidebarEdgePeekTipHost } from './right-sidebar-edge-peek-tip-host'
import { RIGHT_SIDEBAR_EDGE_PEEK_TIP_VISIBLE_MS } from './right-sidebar-edge-peek-tip'

const initialAppState = useAppStore.getInitialState()

function clearToggleAnchors(): void {
  for (const el of document.querySelectorAll('[data-right-sidebar-toggle]')) {
    el.remove()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  cleanup()
  clearToggleAnchors()
  useAppStore.setState({
    ...initialAppState,
    rightSidebarOpen: true,
    rightSidebarPeek: false,
    settings: {
      rightSidebarEdgePeekEnabled: true,
      rightSidebarEdgePeekTipDismissed: false
    } as never,
    updateSettings: vi.fn().mockResolvedValue(undefined)
  })
})

afterEach(() => {
  cleanup()
  clearToggleAnchors()
  vi.useRealTimers()
  useAppStore.setState(initialAppState, true)
})

function mountToggleAnchor(): void {
  clearToggleAnchors()
  const btn = document.createElement('button')
  btn.setAttribute('data-right-sidebar-toggle', '')
  btn.getBoundingClientRect = () =>
    ({
      top: 8,
      left: 1600,
      width: 32,
      height: 24,
      bottom: 32,
      right: 1632,
      x: 1600,
      y: 8,
      toJSON: () => ({})
    }) as DOMRect
  document.body.appendChild(btn)
}

describe('RightSidebarEdgePeekTipHost', () => {
  it('shows a brief tip under the toggle on the first open→closed transition', () => {
    mountToggleAnchor()
    const { rerender } = render(<RightSidebarEdgePeekTipHost />)
    expect(screen.queryByTestId('right-sidebar-edge-peek-tip')).toBeNull()

    act(() => {
      useAppStore.setState({ rightSidebarOpen: false })
    })
    rerender(<RightSidebarEdgePeekTipHost />)

    const tip = screen.getByTestId('right-sidebar-edge-peek-tip')
    expect(tip.textContent).toContain('Hover over the right edge of the screen')
    expect(tip.textContent).toContain('Turn this off in')
    expect(tip.textContent).toMatch(/Settings/)
    expect(screen.getByTestId('right-sidebar-edge-peek-tip-settings-link')).toBeTruthy()
  })

  it('auto-hides after the visible duration and marks the tip dismissed', () => {
    mountToggleAnchor()
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ updateSettings })
    const { rerender } = render(<RightSidebarEdgePeekTipHost />)

    act(() => {
      useAppStore.setState({ rightSidebarOpen: false })
    })
    rerender(<RightSidebarEdgePeekTipHost />)
    expect(screen.getByTestId('right-sidebar-edge-peek-tip')).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(RIGHT_SIDEBAR_EDGE_PEEK_TIP_VISIBLE_MS)
    })

    expect(screen.queryByTestId('right-sidebar-edge-peek-tip')).toBeNull()
    expect(updateSettings).toHaveBeenCalledWith({ rightSidebarEdgePeekTipDismissed: true })
  })

  it.each([
    [
      'pointer hover',
      (link: HTMLElement) => fireEvent.pointerEnter(link),
      (link: HTMLElement) => fireEvent.pointerLeave(link)
    ],
    [
      'keyboard focus',
      (link: HTMLElement) => fireEvent.focus(link),
      (link: HTMLElement) => fireEvent.blur(link)
    ]
  ])('keeps the Settings link available during %s', (_label, beginInteraction, endInteraction) => {
    mountToggleAnchor()
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ updateSettings })
    const { rerender } = render(<RightSidebarEdgePeekTipHost />)

    act(() => {
      useAppStore.setState({ rightSidebarOpen: false })
    })
    rerender(<RightSidebarEdgePeekTipHost />)
    const link = screen.getByTestId('right-sidebar-edge-peek-tip-settings-link')

    beginInteraction(link)
    act(() => {
      vi.advanceTimersByTime(RIGHT_SIDEBAR_EDGE_PEEK_TIP_VISIBLE_MS * 2)
    })
    expect(screen.getByTestId('right-sidebar-edge-peek-tip')).toBeTruthy()
    expect(updateSettings).not.toHaveBeenCalled()

    endInteraction(link)
    act(() => {
      vi.advanceTimersByTime(RIGHT_SIDEBAR_EDGE_PEEK_TIP_VISIBLE_MS)
    })
    expect(screen.queryByTestId('right-sidebar-edge-peek-tip')).toBeNull()
    expect(updateSettings).toHaveBeenCalledWith({ rightSidebarEdgePeekTipDismissed: true })
  })

  it('does not show when the tip was already dismissed', () => {
    mountToggleAnchor()
    useAppStore.setState({
      settings: {
        rightSidebarEdgePeekEnabled: true,
        rightSidebarEdgePeekTipDismissed: true
      } as never
    })
    const { rerender } = render(<RightSidebarEdgePeekTipHost />)

    act(() => {
      useAppStore.setState({ rightSidebarOpen: false })
    })
    rerender(<RightSidebarEdgePeekTipHost />)

    expect(screen.queryByTestId('right-sidebar-edge-peek-tip')).toBeNull()
  })

  it('does not show without a measurable toggle anchor', () => {
    const { rerender } = render(<RightSidebarEdgePeekTipHost />)

    act(() => {
      useAppStore.setState({ rightSidebarOpen: false })
    })
    rerender(<RightSidebarEdgePeekTipHost />)

    expect(screen.queryByTestId('right-sidebar-edge-peek-tip')).toBeNull()
  })
})
