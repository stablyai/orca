// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CropRect } from './pet-image-crop'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { PetSourceCrop } from './PetSourceCrop'

const IMAGE = { width: 200, height: 100 }
const BOX = 120

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(crop: CropRect | null, onCrop: (rect: CropRect) => void): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <PetSourceCrop
        sourceUrl="data:image/png;base64,SOURCE"
        image={IMAGE}
        crop={crop}
        onCrop={onCrop}
        box={BOX}
      />
    )
  })
}

function surface(): HTMLElement {
  const el = document.querySelector('[data-crop-surface]')
  if (!el) {
    throw new Error('no crop surface')
  }
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: BOX, height: 60, right: BOX, bottom: 60, x: 0, y: 0 }) as DOMRect
  return el as HTMLElement
}

function press(key: string, options: { shiftKey?: boolean } = {}): void {
  act(() => {
    surface().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options }))
  })
  act(() => {
    surface().dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, ...options }))
  })
}

function pointer(type: string, x: number, y: number): void {
  act(() => {
    surface().dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1 })
    )
  })
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

describe('PetSourceCrop', () => {
  it('can be reached and framed without a mouse', () => {
    const onCrop = vi.fn()
    render(null, onCrop)

    expect(surface().tabIndex).toBe(0)
    expect(surface().getAttribute('aria-label')).toBeTruthy()

    press('ArrowRight')

    expect(onCrop).toHaveBeenCalledTimes(1)
    const rect = onCrop.mock.calls[0][0] as CropRect
    expect(rect.width).toBeGreaterThan(0)
    expect(rect.width).toBeLessThan(IMAGE.width)
  })

  it('waits for the key to come up, so a held arrow is one framing', () => {
    const onCrop = vi.fn()
    render(null, onCrop)

    act(() => {
      surface().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      surface().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      surface().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(onCrop).not.toHaveBeenCalled()

    act(() => {
      surface().dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
    })
    expect(onCrop).toHaveBeenCalledTimes(1)
  })

  it('moves the frame with the arrows and resizes it with shift', () => {
    const start: CropRect = { x: 40, y: 20, width: 80, height: 40 }
    const moved = vi.fn()
    render(start, moved)
    press('ArrowRight')
    const afterMove = moved.mock.calls[0][0] as CropRect

    expect(afterMove.x).toBeGreaterThan(start.x)
    expect(afterMove.width).toBe(start.width)

    const resized = vi.fn()
    act(() => root?.unmount())
    container?.remove()
    render(start, resized)
    press('ArrowRight', { shiftKey: true })
    const afterResize = resized.mock.calls[0][0] as CropRect

    expect(afterResize.width).toBeGreaterThan(start.width)
    expect(afterResize.x).toBe(start.x)
  })

  it('drops a cancelled gesture instead of leaving the rectangle stuck', () => {
    const onCrop = vi.fn()
    render(null, onCrop)

    pointer('pointerdown', 10, 10)
    pointer('pointermove', 60, 40)
    expect(document.querySelector('[data-crop-frame]')).not.toBeNull()

    pointer('pointercancel', 60, 40)

    expect(onCrop).not.toHaveBeenCalled()
    expect(document.querySelector('[data-crop-frame]')).toBeNull()
  })
})
