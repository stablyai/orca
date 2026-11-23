import { describe, expect, it, vi } from 'vitest'
import {
  dispatchTerminalSideEffectBatch,
  registerTerminalSideEffectFactConsumer
} from './terminal-side-effect-facts-handler'

describe('foreground-changed facts', () => {
  it('routes runtime input to the input path and a host notice to the foreground path', () => {
    // CLI input must reach the pane as input, so a command pane paces it on its slow re-check (#46045).
    const onRuntimeInput = vi.fn()
    const onForegroundChanged = vi.fn()
    const unregister = registerTerminalSideEffectFactConsumer({
      ptyId: 'pty-1',
      callbacks: { onRuntimeInput, onForegroundChanged }
    })

    dispatchTerminalSideEffectBatch({
      ptyId: 'pty-1',
      seq: 1,
      facts: [{ kind: 'foreground-changed', input: true }]
    })
    expect(onRuntimeInput).toHaveBeenCalledTimes(1)
    expect(onForegroundChanged).not.toHaveBeenCalled()

    dispatchTerminalSideEffectBatch({
      ptyId: 'pty-1',
      seq: 2,
      facts: [{ kind: 'foreground-changed' }]
    })
    expect(onForegroundChanged).toHaveBeenCalledTimes(1)
    expect(onRuntimeInput).toHaveBeenCalledTimes(1)
    unregister()
  })
})
