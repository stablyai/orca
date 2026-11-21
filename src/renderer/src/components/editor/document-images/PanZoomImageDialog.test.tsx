// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PanZoomImageDialog } from './PanZoomImageDialog'

// A 1000×800 window; the 400×300 image fits at actual size, centered at (300,250)–(700,550).
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: () => void) {}
      observe(): void {
        this.callback()
      }
      disconnect(): void {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 800))
  Element.prototype.setPointerCapture = () => {}
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function Viewer(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <PanZoomImageDialog
      open={open}
      onOpenChange={setOpen}
      src="https://example.invalid/shot.png"
      size={{ width: 400, height: 300 }}
      title="shot.png"
    />
  )
}

type Point = { x: number; y: number }

function press(from: Point, to = from, via: Point[] = []): void {
  const canvas = screen.getByTestId('pan-zoom-image-canvas')
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: from.x, clientY: from.y })
  for (const point of via) {
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: point.x, clientY: point.y })
  }
  fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: to.x, clientY: to.y })
}

it('zooms in on a click on the image and back to fit on a second; a drag only pans', () => {
  render(<Viewer />)
  const width = (): string | undefined =>
    screen.getByRole('dialog').querySelector('img')?.style.width
  expect(width()).toBe('400px')
  press({ x: 500, y: 400 })
  expect(width()).toBe('800px')
  const position = (): string | undefined =>
    screen.getByRole('dialog').querySelector('img')?.style.transform
  expect(position()).toBe('translate(100px, 100px)')
  press({ x: 500, y: 400 }, { x: 600, y: 450 }, [{ x: 600, y: 450 }])
  expect(width()).toBe('800px')
  expect(position()).toBe('translate(200px, 150px)')
  press({ x: 600, y: 450 })
  expect(width()).toBe('400px')
  expect(screen.queryByRole('dialog')).not.toBeNull()
})

it('stays open for a drag that ends beside the image or comes back to its start', () => {
  render(<Viewer />)
  press({ x: 500, y: 400 }, { x: 50, y: 50 })
  expect(screen.queryByRole('dialog')).not.toBeNull()
  press({ x: 50, y: 50 }, { x: 50, y: 50 }, [{ x: 150, y: 150 }])
  expect(screen.queryByRole('dialog')).not.toBeNull()
})

it('closes on a click beside the image', () => {
  render(<Viewer />)
  press({ x: 50, y: 50 })
  expect(screen.queryByRole('dialog')).toBeNull()
})
