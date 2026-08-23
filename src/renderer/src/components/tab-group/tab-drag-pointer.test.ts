/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDragPointer, isDragPointerOutsideViewport } from './tab-drag-pointer'
import { TabDragPointerSensor } from './tab-drag-pointer-sensor'

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

describe('TabDragPointerSensor window transitions', () => {
  it('keeps an outside drag through focus and restores focus cancellation after re-entry', () => {
    const target = document.createElement('div')
    const initialEvent = new MouseEvent('pointerdown', { clientX: 20, clientY: 20 })
    Object.defineProperty(initialEvent, 'target', { value: target })
    const onCancel = vi.fn()
    new TabDragPointerSensor({
      event: initialEvent,
      options: {},
      onStart: vi.fn(),
      onMove: vi.fn(),
      onEnd: vi.fn(),
      onCancel,
      onAbort: vi.fn()
    } as never)

    document.dispatchEvent(
      new MouseEvent('pointermove', {
        clientX: window.innerWidth + 20,
        clientY: 20,
        cancelable: true
      })
    )
    window.dispatchEvent(new Event('focus'))
    expect(onCancel).not.toHaveBeenCalled()

    document.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 20, clientY: 20, cancelable: true })
    )
    window.dispatchEvent(new Event('focus'))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
