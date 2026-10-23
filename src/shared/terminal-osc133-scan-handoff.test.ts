import { describe, expect, it, vi } from 'vitest'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'
import { createTerminalTitleTracker } from './terminal-output-side-effects'

function marker(payload: string, terminator = '\x07'): string {
  return `\x1b]133;${payload}${terminator}`
}

describe('OSC 133 scanner state handoff', () => {
  it.each(['\x07', '\x1b\\'])('preserves app zones at every handoff with %j', (terminator) => {
    const bubble = ['B', 'C', 'D;0'].map((payload) => marker(payload, terminator)).join('')
    for (let cut = 0; cut <= bubble.length; cut += 1) {
      const started = vi.fn()
      const finished = vi.fn()
      const source = createOsc133CommandFinishedScanner(finished, started)
      const target = createOsc133CommandFinishedScanner(finished, started)
      source.scan(bubble.slice(0, cut))
      target.restoreScanState(source.getScanState())
      target.scan(bubble.slice(cut))
      expect(started).toHaveBeenCalledTimes(1)
      expect(finished).not.toHaveBeenCalled()
      target.scan(marker('C', terminator) + marker('D;0', terminator))
      expect(finished.mock.calls).toEqual([[0]])
    }
  })

  it('keeps snapshots independent and restores without replaying callbacks', () => {
    const started = vi.fn()
    const finished = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(finished, started)
    scanner.scan(`${marker('B')}${marker('C')}\x1b]133;D;`)
    const snapshot = scanner.getScanState()
    scanner.scan('0\x07')
    scanner.reset()
    scanner.restoreScanState(snapshot)
    snapshot.carry = ''
    snapshot.adjacentMarkers = ''
    expect(started).toHaveBeenCalledTimes(1)
    expect(finished).not.toHaveBeenCalled()
    scanner.scan('1\x07')
    expect(finished.mock.calls).toEqual([[1]])
  })

  it('bounds imported state and clears it on reset', () => {
    const finished = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(finished)
    scanner.restoreScanState({ carry: 'x'.repeat(8192), adjacentMarkers: 'ABCD' })
    expect(scanner.getScanState()).toEqual({ carry: 'x'.repeat(4096), adjacentMarkers: 'CD' })
    expect(finished).not.toHaveBeenCalled()
    scanner.reset()
    expect(scanner.getScanState()).toEqual({ carry: '', adjacentMarkers: '' })
    scanner.scan(marker('D;0'))
    expect(finished.mock.calls).toEqual([[0]])
  })

  it('replaces a gapped tracker carry with authoritative state after generic seeding', () => {
    const finished = vi.fn()
    const tracker = createTerminalTitleTracker({ onCommandFinished: finished })
    const authoritative = createOsc133CommandFinishedScanner(() => {})
    tracker.handleChunk(marker('B'))
    tracker.setTransientFactScanningSuppressed(true)
    tracker.handleChunk(`dropped output${marker('D;9')}`)
    authoritative.scan(`${marker('B')}${marker('C')}\x1b]133;D;`)
    tracker.setTransientFactScanningSuppressed(false)
    tracker.handleChunk('\x1b]133;D;', { titleScanData: '' })
    tracker.restoreCommandFinishedScanState(authoritative.getScanState())
    tracker.handleChunk('0\x07')
    expect(finished).not.toHaveBeenCalled()
    tracker.handleChunk(marker('C') + marker('D;0'))
    expect(finished.mock.calls).toEqual([[0]])
    tracker.dispose()
  })
})
