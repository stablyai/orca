import { describe, expect, it } from 'vitest'
import { createCommandCodeOutputStatusDetector } from './command-code-output-status'

function heapAfterGc(): number {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

describe('Command Code output retention', () => {
  it('keeps small boundary carries without pinning oversized output on ordinary panes', () => {
    const before = heapAfterGc()
    const detectors = Array.from({ length: 8 }, (_value, index) => {
      const detector = createCommandCodeOutputStatusDetector({ onWorking: () => {} })
      detector.observe(`${index}:${'x'.repeat(4 * 1024 * 1024)}`)
      return detector
    })
    expect(heapAfterGc() - before).toBeLessThan(2 * 1024 * 1024)
    for (const detector of detectors) {
      expect(detector.observe('\nordinary shell output\n')).toBe(false)
    }
  })
})
