import { describe, expect, it, vi } from 'vitest'
import { CODEX_CAPACITY_MESSAGE, CodexCapacityNoticeTracker } from './codex-capacity-notice'

describe('Codex capacity candidate bounds', () => {
  it('reads neither the screen nor its mode during ordinary output', () => {
    const tracker = new CodexCapacityNoticeTracker()
    const readScreen = vi.fn(() => [])
    const readSynchronized = vi.fn(() => false)
    tracker.observe('ordinary output'.repeat(1000), readScreen, readSynchronized)
    expect(readScreen).not.toHaveBeenCalled()
    expect(readSynchronized).not.toHaveBeenCalled()
  })
  it('does not inspect a partial synchronized frame with combined ANSI modes', () => {
    const tracker = new CodexCapacityNoticeTracker()
    const readScreen = vi.fn(() => [`■ ${CODEX_CAPACITY_MESSAGE}`, '›'])
    expect(tracker.observe(`\x1b[?25;2026h■ ${CODEX_CAPACITY_MESSAGE}`, readScreen)).toBe(false)
    expect(readScreen).not.toHaveBeenCalled()
    expect(tracker.observe('\x1b[?2026;25l', readScreen)).toBe(true)
    expect(readScreen).toHaveBeenCalledTimes(1)
  })
  it('ignores repeated unrelated markers and still accepts a later native notice', () => {
    const tracker = new CodexCapacityNoticeTracker()
    const readScreen = vi.fn(() => [`■ ${CODEX_CAPACITY_MESSAGE}`, '›'])
    expect(tracker.observe('■'.repeat(100_000), readScreen)).toBe(false)
    expect(readScreen).not.toHaveBeenCalled()
    expect(tracker.observe(`■ ${CODEX_CAPACITY_MESSAGE}`, readScreen)).toBe(true)
    expect(readScreen).toHaveBeenCalledTimes(1)
  })
  it('finds the notice inside a large text chunk after unrelated warning markers', () => {
    const tracker = new CodexCapacityNoticeTracker()
    const readScreen = vi.fn(() => [`■ ${CODEX_CAPACITY_MESSAGE}`, '›'])
    expect(
      tracker.observe(
        `⚠ unrelated\n${'x'.repeat(1024 * 1024)}\n■ ${CODEX_CAPACITY_MESSAGE}`,
        readScreen
      )
    ).toBe(true)
    expect(readScreen).toHaveBeenCalledTimes(1)
  })

  it('recognizes a split notice immediately after abandoning an unrelated warning', () => {
    const tracker = new CodexCapacityNoticeTracker()
    const readScreen = vi.fn(() => [`⚠ ${CODEX_CAPACITY_MESSAGE}`, '›'])
    expect(tracker.observe('⚠ 1 warning · f2 to view', readScreen)).toBe(false)
    expect(readScreen).not.toHaveBeenCalled()
    expect(tracker.observe('⚠ Selected model is ', readScreen)).toBe(false)
    expect(tracker.observe('at capacity. Please try a different model.', readScreen)).toBe(true)
    expect(tracker.observe('ordinary output'.repeat(100_000), readScreen)).toBe(false)
    expect(readScreen).toHaveBeenCalledTimes(1)
  })
})
