// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanZoomImageDialog } from './PanZoomImageDialog'

const resizeObservers = new Set<() => void>()

beforeEach(() => {
  resizeObservers.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly notify: () => void
      constructor(callback: ResizeObserverCallback) {
        this.notify = () => callback([], this)
      }
      observe(): void {
        resizeObservers.add(this.notify)
      }
      unobserve(): void {}
      disconnect(): void {
        resizeObservers.delete(this.notify)
      }
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function sizeCanvas(): HTMLElement {
  const canvas = screen.getByTestId('pan-zoom-image-canvas')
  Object.defineProperty(canvas, 'clientWidth', { value: 1000 })
  Object.defineProperty(canvas, 'clientHeight', { value: 600 })
  act(() => resizeObservers.forEach((notify) => notify()))
  return canvas
}

describe('PanZoomImageDialog', () => {
  it('fits a photo by the size it reports on load, then zooms it', async () => {
    const user = userEvent.setup()
    render(
      <PanZoomImageDialog open onOpenChange={() => {}} src="blob:shot" title="shot.png" showTitle />
    )
    sizeCanvas()
    const image = screen.getByRole('img', { name: 'shot.png' })
    expect(image).toHaveClass('invisible')

    Object.defineProperty(image, 'naturalWidth', { value: 2000 })
    Object.defineProperty(image, 'naturalHeight', { value: 1000 })
    fireEvent.load(image)
    expect(image).not.toHaveClass('invisible')
    expect(image.style.width).toBe('968px')
    expect(image.style.transform).toBe('translate(16px, 58px)')

    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(image.style.width).toBe('1210px')
  })

  it('fits again when a pasted thumbnail is replaced by the saved full-size file', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <PanZoomImageDialog open onOpenChange={() => {}} src="data:thumbnail" title="shot.png" />
    )
    const canvas = sizeCanvas()
    const load = (width: number, height: number): HTMLElement => {
      const image = screen.getByRole('img', { name: 'shot.png' })
      Object.defineProperty(image, 'naturalWidth', { value: width, configurable: true })
      Object.defineProperty(image, 'naturalHeight', { value: height, configurable: true })
      fireEvent.load(image)
      return image
    }
    load(320, 160)
    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    canvas.setPointerCapture = vi.fn()
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 140, clientY: 120 })
    fireEvent.pointerUp(canvas, { pointerId: 1 })

    rerender(<PanZoomImageDialog open onOpenChange={() => {}} src="blob:file" title="shot.png" />)
    const image = load(4000, 2000)
    expect(image.style.width).toBe('968px')
    expect(image.style.transform).toBe('translate(16px, 58px)')
    expect(screen.getByRole('button', { name: 'Fit to screen' })).toBeDisabled()
  })

  it('shows the fallback when the image fails to load', () => {
    render(
      <PanZoomImageDialog
        open
        onOpenChange={() => {}}
        src="blob:gone"
        title="gone.png"
        fallback={<span>Preview unavailable</span>}
      />
    )
    fireEvent.error(screen.getByRole('img', { name: 'gone.png' }))
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Preview unavailable')).toBeInTheDocument()
  })
})
