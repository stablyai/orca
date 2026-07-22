import { describe, expect, it, vi } from 'vitest'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'

describe('createOsc133CommandFinishedScanner — prompt-end (;B)', () => {
  it('fires onPromptEnd for a complete OSC 133;B sequence', () => {
    const onPromptEnd = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(vi.fn(), undefined, onPromptEnd)
    scanner.scan('\x1b]133;B\x07')
    expect(onPromptEnd).toHaveBeenCalledTimes(1)
  })

  it('does not fire onCommandFinished or onCommandStarted for ;B', () => {
    const onCommandFinished = vi.fn()
    const onCommandStarted = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(onCommandFinished, onCommandStarted, vi.fn())
    scanner.scan('\x1b]133;B\x07')
    expect(onCommandFinished).not.toHaveBeenCalled()
    expect(onCommandStarted).not.toHaveBeenCalled()
  })

  it('still fires onCommandStarted for ;C when onPromptEnd is also provided', () => {
    const onCommandStarted = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(vi.fn(), onCommandStarted, vi.fn())
    scanner.scan('\x1b]133;C\x07')
    expect(onCommandStarted).toHaveBeenCalledTimes(1)
  })

  it('handles ;B split across two chunks', () => {
    const onPromptEnd = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(vi.fn(), undefined, onPromptEnd)
    scanner.scan('\x1b]133;')
    scanner.scan('B\x07')
    expect(onPromptEnd).toHaveBeenCalledTimes(1)
  })
})
