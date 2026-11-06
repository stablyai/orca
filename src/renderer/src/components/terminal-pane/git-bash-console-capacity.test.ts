import { describe, expect, it } from 'vitest'
import { createGitBashConsoleCapacityDetector } from './git-bash-console-capacity'

describe('Git Bash console capacity detection', () => {
  it('detects the marker at every chunk boundary, in any case', () => {
    const noisyPrefix = 'x'.repeat(200)
    const stream = `${noisyPrefix}Console device allocation failure - TOO MANY CONSOLES In Use, Max Consoles Is 128\r\n`

    for (let split = 0; split <= stream.length; split += 1) {
      const detector = createGitBashConsoleCapacityDetector()
      detector.observe(stream.slice(0, split))
      detector.observe(stream.slice(split))
      expect(detector.detected(), `split at ${split}`).toBe(true)
    }
  })

  it('still matches when the carry is rebuilt by chunks that skip the fast path', () => {
    const detector = createGitBashConsoleCapacityDetector()

    // None of these chunks contain the marker's final character, so each takes the fast path.
    detector.observe('too many consoles in use, ')
    detector.observe('max consoles is ')
    detector.observe('128')

    expect(detector.detected()).toBe(true)
  })

  it('bounds the initial prefix before scanning large reads, in UTF-16 code units', () => {
    const marker = 'too many consoles in use, max consoles is 128'
    for (const prefix of [
      'x'.repeat(4096 - marker.length),
      `${'😀'.repeat((4096 - marker.length - 1) / 2)}x`
    ]) {
      const atEdge = createGitBashConsoleCapacityDetector(4096)
      atEdge.observe(prefix + marker)
      expect(atEdge.detected()).toBe(true)
      const outside = createGitBashConsoleCapacityDetector(4096)
      outside.observe(`x${prefix}${marker}${'x'.repeat(100_000)}`)
      outside.observe(marker)
      expect(outside.detected()).toBe(false)
    }
  })
})
