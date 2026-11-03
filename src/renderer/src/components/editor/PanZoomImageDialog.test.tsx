// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { registerZoomIpcBridge } from '@/hooks/ipc-events/zoom-ipc-bridge'
import { useAppStore } from '@/store'
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
    fireEvent.pointerDown(canvas, {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
      altKey: true
    })
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 140, clientY: 120, altKey: true })
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 140, clientY: 120, altKey: true })

    rerender(<PanZoomImageDialog open onOpenChange={() => {}} src="blob:file" title="shot.png" />)
    const image = load(4000, 2000)
    expect(image.style.width).toBe('968px')
    expect(image.style.transform).toBe('translate(16px, 58px)')
    expect(screen.getByRole('button', { name: 'Fit to screen' })).toBeDisabled()
  })

  it('clicks between fit and actual size, and pans only while Alt is held', () => {
    render(<PanZoomImageDialog open onOpenChange={() => {}} src="blob:shot" title="shot.png" />)
    const canvas = sizeCanvas()
    canvas.setPointerCapture = vi.fn()
    const image = screen.getByRole('img', { name: 'shot.png' })
    Object.defineProperty(image, 'naturalWidth', { value: 2000 })
    Object.defineProperty(image, 'naturalHeight', { value: 1000 })
    fireEvent.load(image)
    const press = (from: [number, number], to: [number, number], altKey = false): void => {
      const [x, y] = from
      fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x, clientY: y, altKey })
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: to[0], clientY: to[1], altKey })
      fireEvent.pointerUp(canvas, { pointerId: 1, clientX: to[0], clientY: to[1], altKey })
    }
    expect(canvas).toHaveClass('cursor-zoom-in')

    press([500, 300], [500, 300])
    expect(image.style.width).toBe('2000px')
    expect(image.style.transform).toBe('translate(-500px, -200px)')
    expect(canvas).toHaveClass('cursor-zoom-out')

    press([500, 300], [540, 320])
    expect(image.style.transform).toBe('translate(-500px, -200px)')

    fireEvent.keyDown(window, { key: 'Alt', altKey: true })
    expect(canvas).toHaveClass('cursor-grab')
    press([500, 300], [540, 320], true)
    expect(image.style.transform).toBe('translate(-460px, -180px)')
    fireEvent.keyUp(window, { key: 'Alt', altKey: false })

    press([500, 300], [500, 300])
    expect(image.style.width).toBe('968px')
  })

  it('takes app zoom that would otherwise change UI Zoom while it is the front dialog', () => {
    type Direction = 'in' | 'out' | 'reset'
    let sendZoom: ((direction: Direction) => void) | undefined
    const setZoomLevel = vi.fn()
    const saveUI = vi.fn()
    vi.stubGlobal('api', {
      ui: {
        onTerminalZoom: (listener: (direction: Direction) => void) => {
          sendZoom = listener
          return () => {}
        },
        getZoomLevel: () => 0,
        setZoomLevel,
        syncTrafficLights: () => {},
        set: saveUI
      }
    })
    const { activeView, activeTabType, editorFontZoomLevel } = useAppStore.getState()
    try {
      useAppStore.setState({ activeView: 'terminal', activeTabType: 'agent-session' })
      registerZoomIpcBridge([])
      const zoom = (direction: Direction): void => act(() => sendZoom?.(direction))
      render(<PanZoomImageDialog open onOpenChange={() => {}} src="blob:shot" title="shot.png" />)
      sizeCanvas()
      const image = screen.getByRole('img', { name: 'shot.png' })
      Object.defineProperty(image, 'naturalWidth', { value: 2000 })
      Object.defineProperty(image, 'naturalHeight', { value: 1000 })
      fireEvent.load(image)

      zoom('in')
      expect(image.style.width).toBe('1210px')
      zoom('reset')
      expect(image.style.width).toBe('968px')
      // Stand-in for Fit to screen, which disables itself and drops focus to the body.
      act(() => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
      })
      zoom('in')
      expect(image.style.width).toBe('1210px')

      useAppStore.setState({ activeTabType: 'editor', editorFontZoomLevel: 0 })
      zoom('out')
      expect(image.style.width).toBe('968px')
      expect(useAppStore.getState().editorFontZoomLevel).toBe(0)
      expect(setZoomLevel).not.toHaveBeenCalled()
      expect(saveUI).not.toHaveBeenCalled()

      // Stand-in for the workspace board: a non-modal sheet drawn over the viewer keeps today's UI Zoom.
      useAppStore.setState({ activeTabType: 'agent-session' })
      render(
        <Dialog open modal={false}>
          <DialogContent onOpenAutoFocus={(event) => event.preventDefault()}>
            <DialogTitle>Board</DialogTitle>
          </DialogContent>
        </Dialog>
      )
      zoom('in')
      expect(image.style.width).toBe('968px')
      expect(setZoomLevel).toHaveBeenCalledWith(0.5)
      expect(saveUI).toHaveBeenCalledWith({ uiZoomLevel: 0.5 })
    } finally {
      useAppStore.setState({ activeView, activeTabType, editorFontZoomLevel })
      document.documentElement.style.removeProperty('--ui-zoom-factor')
    }
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
