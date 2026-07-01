import { describe, expect, it } from 'vitest'
import { createShutdownBufferCaptureGate } from './shutdown-buffer-capture-gate'

describe('createShutdownBufferCaptureGate', () => {
  it('keeps one shutdown capture per quit attempt and can reset after abort', () => {
    const gate = createShutdownBufferCaptureGate()

    expect(gate.canCapture()).toBe(true)
    gate.markCaptured()
    expect(gate.canCapture()).toBe(false)

    gate.reset()
    expect(gate.canCapture()).toBe(true)
  })
})
