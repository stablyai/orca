// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { installCtrlCmdSwap, setCtrlCmdSwapEnabled } from './install-modifier-remap'

let dispose: (() => void) | null = null

afterEach(() => {
  dispose?.()
  dispose = null
  setCtrlCmdSwapEnabled(false)
})

/** Dispatches through window so the capture listener sees the object a consumer would. */
function dispatch(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('installCtrlCmdSwap', () => {
  it('rewrites cmd to ctrl so downstream consumers encode a control chord', () => {
    dispose = installCtrlCmdSwap()
    setCtrlCmdSwapEnabled(true)

    const event = dispatch({ key: 'c', code: 'KeyC', metaKey: true })

    expect(event.ctrlKey).toBe(true)
    expect(event.metaKey).toBe(false)
  })

  it('rewrites ctrl to cmd so app chords fire from the ctrl key', () => {
    dispose = installCtrlCmdSwap()
    setCtrlCmdSwapEnabled(true)

    const event = dispatch({ key: 'p', code: 'KeyP', ctrlKey: true })

    expect(event.metaKey).toBe(true)
    expect(event.ctrlKey).toBe(false)
  })

  it('leaves events untouched while disabled', () => {
    dispose = installCtrlCmdSwap()

    const event = dispatch({ key: 'c', code: 'KeyC', metaKey: true })

    expect(event.metaKey).toBe(true)
    expect(event.ctrlKey).toBe(false)
  })

  it('preserves chords that hold both modifiers, and unmodified keys', () => {
    dispose = installCtrlCmdSwap()
    setCtrlCmdSwapEnabled(true)

    const both = dispatch({ key: 'k', code: 'KeyK', ctrlKey: true, metaKey: true })
    expect(both.ctrlKey).toBe(true)
    expect(both.metaKey).toBe(true)

    const bare = dispatch({ key: 'a', code: 'KeyA', shiftKey: true })
    expect(bare.ctrlKey).toBe(false)
    expect(bare.metaKey).toBe(false)
    expect(bare.shiftKey).toBe(true)
  })

  it('stops rewriting after dispose', () => {
    const stop = installCtrlCmdSwap()
    setCtrlCmdSwapEnabled(true)
    stop()

    const event = dispatch({ key: 'c', code: 'KeyC', metaKey: true })

    expect(event.metaKey).toBe(true)
    expect(event.ctrlKey).toBe(false)
  })
})
