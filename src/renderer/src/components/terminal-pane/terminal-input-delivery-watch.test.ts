import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalInputDeliveryWatch } from './terminal-input-delivery-watch'

function keydown(
  key: string,
  overrides: Partial<KeyboardEvent> = {}
): Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'isComposing' | 'key' | 'keyCode' | 'metaKey' | 'repeat'
> {
  return {
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key,
    keyCode: key.charCodeAt(0),
    metaKey: false,
    repeat: false,
    ...overrides
  }
}

describe('createTerminalInputDeliveryWatch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('requests recovery when an ASCII letter produces no terminal input', () => {
    const onUndeliverable = vi.fn()
    const watch = createTerminalInputDeliveryWatch({ onUndeliverable })

    watch.observeKeydown(keydown('z'))
    vi.advanceTimersByTime(499)
    expect(onUndeliverable).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(onUndeliverable).toHaveBeenCalledTimes(1)
  })

  it('cancels recovery when xterm reports delivered user input', () => {
    const onUndeliverable = vi.fn()
    const watch = createTerminalInputDeliveryWatch({ onUndeliverable })

    watch.observeKeydown(keydown('z'))
    watch.observeDeliveredInput()
    vi.advanceTimersByTime(500)

    expect(onUndeliverable).not.toHaveBeenCalled()
  })

  it('requests recovery when a completed Korean composition produces no terminal input', () => {
    const onUndeliverable = vi.fn()
    const watch = createTerminalInputDeliveryWatch({ onUndeliverable })

    watch.observeCompositionStart()
    watch.observeCompositionInput('한')
    watch.observeCompositionEnd('한')
    vi.advanceTimersByTime(500)

    expect(onUndeliverable).toHaveBeenCalledTimes(1)
  })

  it('cancels composition recovery when xterm reports delivered user input', () => {
    const onUndeliverable = vi.fn()
    const watch = createTerminalInputDeliveryWatch({ onUndeliverable })

    watch.observeCompositionStart()
    watch.observeCompositionInput('한')
    watch.observeCompositionEnd('한')
    watch.observeDeliveredInput()
    vi.advanceTimersByTime(500)

    expect(onUndeliverable).not.toHaveBeenCalled()
  })

  it('does not arm recovery when xterm delivers the composition before compositionend', () => {
    const onUndeliverable = vi.fn()
    const watch = createTerminalInputDeliveryWatch({ onUndeliverable })

    watch.observeCompositionStart()
    watch.observeCompositionInput('한')
    watch.observeDeliveredInput()
    watch.observeCompositionEnd('한')
    vi.advanceTimersByTime(500)

    expect(onUndeliverable).not.toHaveBeenCalled()
  })

  it('ignores cancelled compositions and empty composition input', () => {
    const onUndeliverable = vi.fn()
    const watch = createTerminalInputDeliveryWatch({ onUndeliverable })

    watch.observeCompositionStart()
    watch.observeCompositionInput('한')
    watch.observeCompositionEnd('')
    watch.observeCompositionStart()
    watch.observeCompositionInput('')
    watch.observeCompositionEnd('한')
    vi.advanceTimersByTime(1_000)

    expect(onUndeliverable).not.toHaveBeenCalled()
  })

  it('ignores duplicate compositionend after one recovery request', () => {
    const onUndeliverable = vi.fn()
    const watch = createTerminalInputDeliveryWatch({ onUndeliverable })

    watch.observeCompositionStart()
    watch.observeCompositionInput('한')
    watch.observeCompositionEnd('한')
    watch.observeCompositionEnd('한')
    vi.advanceTimersByTime(1_000)

    expect(onUndeliverable).toHaveBeenCalledTimes(1)
  })

  it('ignores IME, shortcuts, repeats, and modifier-only keys', () => {
    const onUndeliverable = vi.fn()
    const watch = createTerminalInputDeliveryWatch({ onUndeliverable })

    watch.observeKeydown(keydown('Process', { isComposing: true, keyCode: 229 }))
    watch.observeKeydown(keydown('c', { metaKey: true }))
    watch.observeKeydown(keydown('z', { repeat: true }))
    watch.observeKeydown(keydown('Shift'))
    vi.advanceTimersByTime(1_000)

    expect(onUndeliverable).not.toHaveBeenCalled()
  })

  it('ignores IME candidate-selection and control keys', () => {
    const onUndeliverable = vi.fn()
    const watch = createTerminalInputDeliveryWatch({ onUndeliverable })

    watch.observeKeydown(keydown(' '))
    watch.observeKeydown(keydown('1'))
    watch.observeKeydown(keydown('Enter'))
    watch.observeKeydown(keydown('Backspace'))
    vi.advanceTimersByTime(1_000)

    expect(onUndeliverable).not.toHaveBeenCalled()
  })

  it('cancels pending recovery on dispose', () => {
    const onUndeliverable = vi.fn()
    const watch = createTerminalInputDeliveryWatch({ onUndeliverable })

    watch.observeKeydown(keydown('z'))
    watch.dispose()
    vi.advanceTimersByTime(500)

    expect(onUndeliverable).not.toHaveBeenCalled()
  })
})
