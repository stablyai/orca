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

function press(from: { x: number; y: number }, to = from): void {
  const canvas = screen.getByTestId('pan-zoom-image-canvas')
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: from.x, clientY: from.y })
  fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: to.x, clientY: to.y })
}

it('stays open for a click on the image and for a drag that ends beside it', () => {
  render(<Viewer />)
  press({ x: 500, y: 400 })
  expect(screen.queryByRole('dialog')).not.toBeNull()
  press({ x: 500, y: 400 }, { x: 50, y: 50 })
  expect(screen.queryByRole('dialog')).not.toBeNull()
})

it('closes on a click beside the image', () => {
  render(<Viewer />)
  press({ x: 50, y: 50 })
  expect(screen.queryByRole('dialog')).toBeNull()
})
