// @vitest-environment happy-dom
import type { PointerSensorOptions, SensorProps } from '@dnd-kit/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TabDragPointerSensor } from './tab-drag-pointer-sensor'

describe('TabDragPointerSensor', () => {
  let target: HTMLElement

  beforeEach(() => {
    target = document.createElement('div')
    document.body.appendChild(target)
  })

  afterEach(() => {
    target.remove()
    vi.clearAllMocks()
  })

  function createSensor(options = { distance: 12 }) {
    const onStart = vi.fn()
    const onMove = vi.fn()
    const onEnd = vi.fn()
    const onCancel = vi.fn()
    const onPending = vi.fn()
    const onAbort = vi.fn()

    const event = new PointerEvent('pointerdown', {
      clientX: 100,
      clientY: 100,
      isPrimary: true,
      button: 0,
      buttons: 1
    })
    Object.defineProperty(event, 'target', { value: target })

    const props = {
      active: 'tab-1',
      activeNode: null,
      event,
      options: {
        activationConstraint: { distance: options.distance }
      },
      onStart,
      onMove,
      onEnd,
      onCancel,
      onPending,
      onAbort
    }

    const sensor = new TabDragPointerSensor(
      props as unknown as ConstructorParameters<typeof TabDragPointerSensor>[0]
    )
    return { sensor, onStart, onMove, onEnd, onCancel, onPending, onAbort }
  }

  it('cancels immediately when pointer moves with no mouse button pressed', () => {
    const { onAbort, onStart } = createSensor()

    // Mouse moved back into window without button held (buttons: 0)
    document.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 200,
        clientY: 200,
        buttons: 0
      })
    )

    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
  })

  it('cancels immediately when window receives blur', () => {
    const { onAbort, onStart } = createSensor()

    window.dispatchEvent(new Event('blur'))

    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
  })

  it('cancels immediately when document visibility changes to hidden', () => {
    const { onAbort, onStart } = createSensor()

    document.dispatchEvent(new Event('visibilitychange'))

    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
  })

  it('cancels on blur when active in an auxiliary popout window', () => {
    const popoutDoc = document.implementation.createHTMLDocument('Popout')
    const popoutWin = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    Object.defineProperty(popoutDoc, 'defaultView', { value: popoutWin })

    const popoutTarget = popoutDoc.createElement('div')
    popoutDoc.body.appendChild(popoutTarget)

    const onAbort = vi.fn()
    const onStart = vi.fn()
    const event = new PointerEvent('pointerdown', {
      clientX: 50,
      clientY: 50,
      isPrimary: true,
      button: 0,
      buttons: 1
    })
    Object.defineProperty(event, 'target', { value: popoutTarget })

    const props = {
      active: 'tab-popout',
      activeNode: null,
      event,
      options: {
        activationConstraint: { distance: 12 }
      },
      onStart,
      onMove: vi.fn(),
      onEnd: vi.fn(),
      onCancel: vi.fn(),
      onPending: vi.fn(),
      onAbort
    }

    new TabDragPointerSensor(
      props as unknown as ConstructorParameters<typeof TabDragPointerSensor>[0]
    )

    // Verify blur was attached to popout window
    expect(popoutWin.addEventListener).toHaveBeenCalledWith('blur', expect.any(Function), undefined)

    // Trigger blur handler directly from popout window listener registration
    const blurCall = popoutWin.addEventListener.mock.calls.find(([event]) => event === 'blur')
    expect(blurCall).toBeDefined()
    blurCall?.[1](new Event('blur'))

    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
  })
})

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
  // Why: merged cancellation semantics cancel moves with no button held
  // (capture lost), so synthetic moves must model an in-progress drag.
  document.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 50, buttons: 1 }))
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
