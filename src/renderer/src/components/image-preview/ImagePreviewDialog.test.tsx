// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogContent: ({
    children,
    overlayClassName: _overlayClassName,
    showCloseButton: _showCloseButton,
    ...props
  }: {
    children: ReactNode
    overlayClassName?: string
    showCloseButton?: boolean
  }) => (
    <div role="dialog" {...props}>
      {children}
    </div>
  ),
  DialogClose: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children, ...props }: { children: ReactNode }) => <h2 {...props}>{children}</h2>
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { ImagePreviewDialog } from './ImagePreviewDialog'

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
  disconnect(): void {}
}

describe('ImagePreviewDialog', () => {
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
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('fits, follows the Codex zoom ramp, and routes viewer actions', async () => {
    const onDownload = vi.fn()
    const onPrevious = vi.fn()
    const onNext = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ImagePreviewDialog
        preview={{
          fileName: 'screenshot.png',
          src: 'blob:test',
          onDownload,
          onPrevious,
          onNext
        }}
        onOpenChange={onOpenChange}
      />
    )

    const image = await screen.findByRole('img')
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' })
    expect(image.style.width).toBe('800px')
    expect(screen.getByRole('button', { name: 'Zoom to fit' }).textContent).toBe('80%')

    fireEvent.click(zoomIn)
    expect(image.style.width).toBe('900px')
    for (let index = 0; index < 20; index += 1) {
      fireEvent.click(zoomIn)
    }
    expect(image.style.width).toBe('5000px')
    expect((zoomIn as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Zoom to fit' }))
    expect(image.style.width).toBe('800px')
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' })
    fireEvent.click(screen.getByTestId('image-preview-surface'))

    expect(onDownload).toHaveBeenCalledOnce()
    expect(onPrevious).toHaveBeenCalledOnce()
    expect(onNext).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the dialog mounted while switching images', async () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(
      <ImagePreviewDialog
        preview={{ fileName: 'first.png', src: 'blob:first', onDownload: vi.fn() }}
        onOpenChange={onOpenChange}
      />
    )
    const dialog = screen.getByRole('dialog')

    rerender(
      <ImagePreviewDialog
        preview={{ fileName: 'second.png', src: 'blob:second', onDownload: vi.fn() }}
        onOpenChange={onOpenChange}
      />
    )

    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(screen.getByRole('img').getAttribute('src')).toBe('blob:second')
  })

  it('keeps wheel, pinch, and mouse drag anchored to the image surface', async () => {
    render(
      <ImagePreviewDialog
        preview={{ fileName: 'screenshot.png', src: 'blob:test', onDownload: vi.fn() }}
        onOpenChange={vi.fn()}
      />
    )
    const image = await screen.findByRole('img')
    const surface = screen.getByTestId('image-preview-surface')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    surface.scrollLeft = 100
    surface.scrollTop = 80
    fireEvent.pointerDown(image, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 400,
      clientY: 300
    })
    fireEvent.pointerMove(surface, {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 350,
      clientY: 250
    })
    fireEvent.pointerUp(surface, { pointerId: 1, pointerType: 'mouse' })
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
    expect(screen.getByRole('button', { name: 'Zoom to fit' }).textContent).toBe('111%')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom to fit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
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
    expect(screen.getByRole('button', { name: 'Zoom to fit' }).textContent).toBe('150%')
  })
})
