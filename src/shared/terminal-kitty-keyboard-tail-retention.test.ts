import { describe, expect, it } from 'vitest'
import { TerminalKittyKeyboardModeTracker } from './terminal-kitty-keyboard-mode-tracker'

const INCOMPLETE_MODE = '\x1b[?1049;2004;1000;'

function heapAfterGc(): number {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  // Isolate tracker ownership from V8's process-wide last successful regexp input.
  void /reset/.test('reset')
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

describe('kitty keyboard scan tail retention', () => {
  it.each(['scan', 'scanReplay'] as const)(
    '%s retains a split mode sequence without retaining consumed output',
    (method) => {
      const before = heapAfterGc()
      const trackers = Array.from({ length: 8 }, (_value, index) => {
        const tracker = new TerminalKittyKeyboardModeTracker()
        tracker[method](`${index}:${'x'.repeat(4 * 1024 * 1024)}${INCOMPLETE_MODE}`)
        return tracker
      })

      expect(heapAfterGc() - before).toBeLessThan(2 * 1024 * 1024)
      for (const tracker of trackers) {
        expect(tracker.isAlternateScreen).toBe(false)
        tracker[method]('1006h\x1b[>3u')
        expect(tracker.isAlternateScreen).toBe(true)
        expect(tracker.flags).toBe(3)
        tracker.scan('\x1b[<u')
        expect(tracker.flags).toBe(0)
        tracker.resetForSnapshot()
        expect(tracker.snapshotFlags).toBeUndefined()
      }
    }
  )
})
