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
  it('cancels an active gesture on blur and stops subsequent moves and drops', () => {
    const callbacks = startSensor()
    expect(callbacks.onStart).toHaveBeenCalledOnce()
    movePointer()
    expect(callbacks.onMove).toHaveBeenCalledOnce()

    window.dispatchEvent(new Event('blur'))
    expect(callbacks.onCancel).toHaveBeenCalledOnce()
    expect(callbacks.onAbort).not.toHaveBeenCalled()
    movePointer()
    document.dispatchEvent(new PointerEvent('pointerup'))

    expect(callbacks.onMove).toHaveBeenCalledOnce()
    expect(callbacks.onEnd).not.toHaveBeenCalled()
  })

  it.each<PointerSensorOptions['activationConstraint']>([
    { distance: 12 },
    { delay: 100, tolerance: 10 }
  ])('aborts a pending gesture on blur before activation: %j', (activationConstraint) => {
    const callbacks = startSensor({ activationConstraint })
    expect(callbacks.onStart).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('blur'))
    expect(callbacks.onAbort).toHaveBeenCalledWith('tab-1')
    expect(callbacks.onCancel).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(150)
    movePointer()
    movePointer()
    document.dispatchEvent(new PointerEvent('pointerup'))

    expect(callbacks.onStart).not.toHaveBeenCalled()
    expect(callbacks.onMove).not.toHaveBeenCalled()
    expect(callbacks.onEnd).not.toHaveBeenCalled()
  })

  it('still completes an uninterrupted gesture on pointerup', () => {
    const callbacks = startSensor()
    movePointer()
    document.dispatchEvent(new PointerEvent('pointerup'))
    window.dispatchEvent(new Event('blur'))
    movePointer()

    expect(callbacks.onEnd).toHaveBeenCalledOnce()
    expect(callbacks.onMove).toHaveBeenCalledOnce()
    expect(callbacks.onCancel).not.toHaveBeenCalled()
    expect(callbacks.onAbort).not.toHaveBeenCalled()
  })

  it('does not restart when a captured activation callback arrives after cancellation', () => {
    const schedule = vi.spyOn(window, 'setTimeout')
    const callbacks = startSensor({ activationConstraint: { delay: 100, tolerance: 10 } })
    const activate = schedule.mock.calls[0]?.[0]
    expect(activate).toBeTypeOf('function')
    window.dispatchEvent(new Event('blur'))
    ;(activate as () => void)()

    expect(callbacks.onStart).not.toHaveBeenCalled()
    expect(callbacks.onCancel).toHaveBeenCalledOnce()
  })

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
