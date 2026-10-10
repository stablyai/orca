// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { matchesActiveDragPointer, releasePointerCaptureIfHeld } from './drag-pointer-session'

const mouse = { pointerId: 1, pointerType: 'mouse' }

describe('matchesActiveDragPointer', () => {
  it('matches the pointer that started the drag', () => {
    expect(
      matchesActiveDragPointer(mouse, { pointerId: 1, isPrimary: true, pointerType: 'mouse' })
    ).toBe(true)
  })

  it('accepts a primary pen taking over a mouse drag, which is how WSLg relays motion', () => {
    expect(
      matchesActiveDragPointer(mouse, { pointerId: 9, isPrimary: true, pointerType: 'pen' })
    ).toBe(true)
  })

  it('ignores a stray finger during a mouse drag', () => {
    expect(
      matchesActiveDragPointer(mouse, { pointerId: 9, isPrimary: true, pointerType: 'touch' })
    ).toBe(false)
  })

  it('ignores a stray mouse during a touch drag', () => {
    const touch = { pointerId: 1, pointerType: 'touch' }
    expect(
      matchesActiveDragPointer(touch, { pointerId: 9, isPrimary: true, pointerType: 'mouse' })
    ).toBe(false)
  })

  it('ignores a non-primary pointer it does not own', () => {
    expect(
      matchesActiveDragPointer(mouse, { pointerId: 9, isPrimary: false, pointerType: 'mouse' })
    ).toBe(false)
  })

  it('matches nothing when no drag is active', () => {
    expect(
      matchesActiveDragPointer(null, { pointerId: 1, isPrimary: true, pointerType: 'mouse' })
    ).toBe(false)
  })
})

describe('releasePointerCaptureIfHeld', () => {
  it('releases only what is actually captured', () => {
    const release = vi.fn()
    const el = Object.assign(document.createElement('div'), {
      hasPointerCapture: (id: number) => id === 1,
      releasePointerCapture: release
    })
    releasePointerCaptureIfHeld(el, 2)
    expect(release).not.toHaveBeenCalled()
    releasePointerCaptureIfHeld(el, 1)
    expect(release).toHaveBeenCalledWith(1)
  })

  it('swallows the throw Electron produces when capture is already gone', () => {
    const el = Object.assign(document.createElement('div'), {
      hasPointerCapture: () => true,
      releasePointerCapture: () => {
        throw new Error('NotFoundError')
      }
    })
    expect(() => releasePointerCaptureIfHeld(el, 1)).not.toThrow()
  })

  it('does nothing without an element or pointer', () => {
    expect(() => releasePointerCaptureIfHeld(null, 1)).not.toThrow()
    expect(() => releasePointerCaptureIfHeld(document.createElement('div'), null)).not.toThrow()
  })
})
