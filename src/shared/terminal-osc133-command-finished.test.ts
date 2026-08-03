import { describe, expect, it, vi } from 'vitest'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'

describe('createOsc133CommandFinishedScanner', () => {
  it('reports the exit code for a complete OSC 133;D sequence', () => {
    const onCommandFinished = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(onCommandFinished)

    scanner.scan('build output\x1b]133;D;3\x07more')

    expect(onCommandFinished).toHaveBeenCalledWith(3)
  })

  it('carries an unterminated sequence into the next chunk', () => {
    const onCommandFinished = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(onCommandFinished)

    scanner.scan('\x1b]133;D;')
    expect(onCommandFinished).not.toHaveBeenCalled()

    scanner.scan('7\x07')
    expect(onCommandFinished).toHaveBeenCalledWith(7)
  })

  it('drops the carry on reset', () => {
    const onCommandFinished = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(onCommandFinished)

    scanner.scan('\x1b]133;D;1')
    scanner.reset()
    scanner.scan('\x07')

    expect(onCommandFinished).not.toHaveBeenCalled()
  })
})
