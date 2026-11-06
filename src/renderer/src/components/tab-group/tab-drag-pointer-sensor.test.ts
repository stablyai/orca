// @vitest-environment happy-dom
import type { PointerSensorOptions, SensorProps } from '@dnd-kit/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TabDragPointerSensor } from './tab-drag-pointer-sensor'

function startSensor(options: PointerSensorOptions = {}) {
  const callbacks = {
    onAbort: vi.fn(),
    onPending: vi.fn(),
    onStart: vi.fn(),
    onCancel: vi.fn(),
    onMove: vi.fn(),
    onEnd: vi.fn()
  }
  new TabDragPointerSensor({
    active: 'tab-1',
    event: new PointerEvent('pointerdown', { clientX: 10, clientY: 10 }),
    options,
    ...callbacks
  } as unknown as SensorProps<PointerSensorOptions>)
  return callbacks
}

function movePointer(): void {
  document.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 50 }))
}

beforeEach(() => vi.useFakeTimers())

afterEach(() => {
  window.dispatchEvent(new Event('resize'))
  vi.runOnlyPendingTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('tab drag pointer sensor cancellation', () => {
  it('ignores the old Escape listener while a new gesture is active', () => {
    const previous = startSensor()
    window.dispatchEvent(new Event('blur'))
    const current = startSensor()
    movePointer()
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }))
    document.dispatchEvent(new PointerEvent('pointerup'))

    expect(previous.onCancel).toHaveBeenCalledOnce()
    expect(previous.onMove).not.toHaveBeenCalled()
    expect(current.onStart).toHaveBeenCalledOnce()
    expect(current.onMove).toHaveBeenCalledOnce()
    expect(current.onCancel).toHaveBeenCalledOnce()
    expect(current.onEnd).not.toHaveBeenCalled()
  })
})
