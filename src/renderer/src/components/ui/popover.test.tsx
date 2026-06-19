import { describe, expect, it, vi } from 'vitest'
import { updatePopoverContentRef } from './popover-content-ref'

describe('updatePopoverContentRef', () => {
  it('preserves callback ref cleanup when content detaches', () => {
    const node = {} as HTMLDivElement
    const cancelWheelFrames = vi.fn()
    const cleanup = vi.fn()
    const ref = vi.fn(() => cleanup)

    const detach = updatePopoverContentRef(ref, node, cancelWheelFrames)
    detach?.()

    expect(ref).toHaveBeenCalledTimes(1)
    expect(ref).toHaveBeenCalledWith(node)
    expect(cancelWheelFrames).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('clears callback refs that do not return cleanup', () => {
    const node = {} as HTMLDivElement
    const cancelWheelFrames = vi.fn()
    const ref = vi.fn()

    const detach = updatePopoverContentRef(ref, node, cancelWheelFrames)
    detach?.()

    expect(ref).toHaveBeenNthCalledWith(1, node)
    expect(ref).toHaveBeenNthCalledWith(2, null)
    expect(cancelWheelFrames).toHaveBeenCalledTimes(1)
  })

  it('clears object refs when content detaches', () => {
    const node = {} as HTMLDivElement
    const cancelWheelFrames = vi.fn()
    const ref: { current: HTMLDivElement | null } = { current: null }

    const detach = updatePopoverContentRef(ref, node, cancelWheelFrames)
    expect(ref.current).toBe(node)

    detach?.()

    expect(ref.current).toBeNull()
    expect(cancelWheelFrames).toHaveBeenCalledTimes(1)
  })

  it('cancels pending frames when React supplies a null node', () => {
    const cancelWheelFrames = vi.fn()
    const ref: { current: HTMLDivElement | null } = { current: {} as HTMLDivElement }

    updatePopoverContentRef(ref, null, cancelWheelFrames)

    expect(ref.current).toBeNull()
    expect(cancelWheelFrames).toHaveBeenCalledTimes(1)
  })
})
