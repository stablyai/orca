// @vitest-environment happy-dom
import { type ReactNode, useEffect, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: Record<string, unknown>) => (
    <button {...props}>{children as ReactNode}</button>
  )
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogContent: ({ children, ...props }: { children: ReactNode }) => {
    const [mounted, setMounted] = useState(false)
    useEffect(() => setMounted(true), [])
    return mounted ? <div {...props}>{children}</div> : null
  },
  DialogTitle: ({ children, ...props }: { children: ReactNode }) => <h2 {...props}>{children}</h2>
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({
    children,
    onSelect,
    value
  }: {
    children: ReactNode
    onSelect?: () => void
    value: string
  }) => (
    <button data-value={value} onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { RoomImagePreviewDialog } from './RoomImagePreviewDialog'

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
  disconnect(): void {}
}

describe('RoomImagePreviewDialog', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const width =
          this instanceof HTMLImageElement ? Number.parseFloat(this.style.width) || 1000 : 800
        const height =
          this instanceof HTMLImageElement ? Number.parseFloat(this.style.height) || 500 : 600
        return new DOMRect(0, 0, width, height)
      }
    )
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1000)
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(500)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('matches Codex zoom selection, anchored gestures, and drag panning', async () => {
    render(
      <RoomImagePreviewDialog
        preview={{ fileName: 'screenshot.png', src: 'blob:test', onDownload: vi.fn() }}
        onOpenChange={vi.fn()}
      />
    )

    const image = await screen.findByRole('img')
    expect(screen.getByRole('button', { name: 'Zoom: 80%' })).toBeTruthy()
    expect(image.style.width).toBe('800px')
    for (const preset of [25, 50, 100, 150, 200]) {
      expect(screen.getByRole('button', { name: `${preset}%` })).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: 'Zoom to fit' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '100%' }))
    expect(screen.getByRole('button', { name: 'Zoom: 100%' })).toBeTruthy()
    expect(image.style.width).toBe('1000px')
    expect(image.classList.contains('cursor-grab')).toBe(true)

    const surface = screen.getByTestId('room-image-preview-surface')
    surface.scrollLeft = 100
    surface.scrollTop = 80
    fireEvent.pointerDown(image, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 400,
      clientY: 300
    })
    expect(image.classList.contains('cursor-grabbing')).toBe(true)
    fireEvent.pointerMove(surface, {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 350,
      clientY: 250
    })
    fireEvent.pointerUp(surface, { pointerId: 1, pointerType: 'mouse' })
    expect(image.classList.contains('cursor-grab')).toBe(true)
    expect(surface.scrollLeft).toBe(150)
    expect(surface.scrollTop).toBe(130)

    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -20,
      clientX: 400,
      clientY: 300
    })
    Object.defineProperty(wheel, 'ctrlKey', { value: true })
    await act(() => surface.dispatchEvent(wheel))
    expect(screen.getByRole('button', { name: 'Zoom: 111%' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '100%' }))
    fireEvent.pointerDown(surface, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 300,
      clientY: 300
    })
    fireEvent.pointerDown(surface, {
      pointerId: 3,
      pointerType: 'touch',
      clientX: 500,
      clientY: 300
    })
    fireEvent.pointerMove(surface, {
      pointerId: 3,
      pointerType: 'touch',
      clientX: 600,
      clientY: 300
    })
    expect(screen.getByRole('button', { name: 'Zoom: 150%' })).toBeTruthy()
  })
})
