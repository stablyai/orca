import { describe, expect, it } from 'vitest'
import {
  createTerminalZeroDimensionsMessage,
  isTerminalZeroDimensionsDiagnostic
} from './terminal-zero-dimensions-diagnostic'

describe('terminal zero-dimensions diagnostic', () => {
  it('round-trips its own message through the matcher', () => {
    expect(isTerminalZeroDimensionsDiagnostic(createTerminalZeroDimensionsMessage(0, 0))).toBe(true)
  })

  it('does not match unrelated terminal errors', () => {
    expect(isTerminalZeroDimensionsDiagnostic('Paste failed.')).toBe(false)
    expect(isTerminalZeroDimensionsDiagnostic('Failed to save terminal session state')).toBe(false)
  })
})
