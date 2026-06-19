import { describe, expect, it } from 'vitest'
import { createBellDetector } from './bell-detector'

describe('createBellDetector', () => {
  it('skips ANSI chunks without losing later real bells', () => {
    const detector = createBellDetector()

    expect(detector.chunkContainsBell('\x1b[32mbuild\x1b[0m output')).toBe(false)
    expect(detector.chunkContainsBell('\x07')).toBe(true)
  })

  it('keeps split OSC state so title terminators are not reported as bells', () => {
    const detector = createBellDetector()

    expect(detector.chunkContainsBell('\x1b]0;Codex working')).toBe(false)
    expect(detector.chunkContainsBell('\x07')).toBe(false)
    expect(detector.chunkContainsBell('\x07')).toBe(true)
  })

  it('treats BEL after a split non-OSC escape as a real bell', () => {
    const detector = createBellDetector()

    expect(detector.chunkContainsBell('\x1b')).toBe(false)
    expect(detector.chunkContainsBell('\x07')).toBe(true)
  })
})
