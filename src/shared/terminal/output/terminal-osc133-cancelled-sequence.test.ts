import { expect, it, vi } from 'vitest'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'

it('drops an OSC 133 sequence another escape cancels and still reads the next marker', () => {
  const finished = vi.fn()
  const scanner = createOsc133CommandFinishedScanner(finished)
  scanner.scan('\x1b]133;D;1\x1b[0mtext\x07\x1b]133;D;7\x1b\\')
  expect(finished.mock.calls).toEqual([[7]])
})

it('reads a finish after a cancelled sequence as a real one, not the app zone B,C,D;0', () => {
  const finished = vi.fn()
  const scanner = createOsc133CommandFinishedScanner(finished)
  scanner.scan('\x1b]133;B\x07\x1b]133;C\x07\x1b]133;ignored\x1b]133;D;0\x07')
  expect(finished.mock.calls).toEqual([[0]])
})
