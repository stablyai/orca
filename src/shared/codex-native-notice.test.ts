import { describe, expect, it, vi } from 'vitest'
import { CODEX_CAPACITY_MESSAGE, createCodexCapacityNoticeTracker } from './codex-native-notice'

describe('Codex capacity candidate bounds', () => {
  it('does not inspect a partial synchronized frame with combined ANSI modes', () => {
    const tracker = createCodexCapacityNoticeTracker()
    const readScreen = vi.fn(() => [`■ ${CODEX_CAPACITY_MESSAGE}`, '›'])
    expect(tracker.observe(`\x1b[?25;2026h■ ${CODEX_CAPACITY_MESSAGE}`, readScreen)).toBe(false)
    expect(readScreen).not.toHaveBeenCalled()
    expect(tracker.observe('\x1b[?2026;25l', readScreen)).toBe(true)
    expect(readScreen).toHaveBeenCalledTimes(1)
  })

  it('recognizes a split notice immediately after abandoning an unrelated warning', () => {
    const tracker = createCodexCapacityNoticeTracker()
    const readScreen = vi.fn(() => [`⚠ ${CODEX_CAPACITY_MESSAGE}`, '›'])
    expect(tracker.observe('⚠ 1 warning · f2 to view', readScreen)).toBe(false)
    expect(readScreen).not.toHaveBeenCalled()
    expect(tracker.observe('⚠ Selected model is ', readScreen)).toBe(false)
    expect(tracker.observe('at capacity. Please try a different model.', readScreen)).toBe(true)
    expect(tracker.observe('ordinary output'.repeat(100_000), readScreen)).toBe(false)
    expect(readScreen).toHaveBeenCalledTimes(1)
  })
})
