import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDragPointer, isDragPointerOutsideViewport } from './tab-drag-pointer'

afterEach(() => vi.unstubAllGlobals())

describe('getDragPointer', () => {
  it('uses the activator client coordinates plus drag delta', () => {
    expect(
      getDragPointer({
        activatorEvent: { clientX: 100, clientY: 40 },
        delta: { x: 250, y: 10 },
        active: { rect: { current: { initial: null, translated: null } } }
      } as unknown as Parameters<typeof getDragPointer>[0])
    ).toEqual({ x: 350, y: 50 })
  })
})

describe('isDragPointerOutsideViewport', () => {
  it('distinguishes pointers outside the renderer viewport', () => {
    vi.stubGlobal('window', { innerWidth: 100, innerHeight: 100 })

    expect(isDragPointerOutsideViewport({ x: 99, y: 0 })).toBe(false)
    expect(isDragPointerOutsideViewport({ x: 100, y: 0 })).toBe(true)
    expect(isDragPointerOutsideViewport({ x: -1, y: 0 })).toBe(true)
  })
})
