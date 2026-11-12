import { describe, expect, it, vi } from 'vitest'
import { tokenizeLineWithinLimits } from './textmate-core'

describe('tokenizeLineWithinLimits', () => {
  it('gives up on a line that keeps running out of time', () => {
    const tokenize = vi.fn(() => ({ stoppedEarly: true }))

    expect(tokenizeLineWithinLimits('x', tokenize)).toBeNull()
    expect(tokenize).toHaveBeenCalledTimes(3)
  })

  it('skips a line too long to scan without tokenizing it', () => {
    const tokenize = vi.fn(() => ({ stoppedEarly: false }))

    expect(tokenizeLineWithinLimits('x'.repeat(1001), tokenize)).toBeNull()
    expect(tokenize).not.toHaveBeenCalled()
  })
})
