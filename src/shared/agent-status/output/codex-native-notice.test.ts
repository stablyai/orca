import { describe, expect, it } from 'vitest'
import { CODEX_CAPACITY_MESSAGE, createCodexCapacityNoticeTracker } from './codex-native-notice'

describe('Codex capacity candidate bounds', () => {
  it('does not inspect a partial synchronized frame with combined ANSI modes', () => {
    const tracker = createCodexCapacityNoticeTracker()
    const readScreen = () => [`■ ${CODEX_CAPACITY_MESSAGE}`, '›']
    expect(tracker.observe(`\x1b[?25;2026h■ ${CODEX_CAPACITY_MESSAGE}`, readScreen)).toBe(false)
    expect(tracker.observe('\x1b[?2026;25l', readScreen)).toBe(true)
  })

  it('recognizes a split notice immediately after abandoning an unrelated warning', () => {
    const tracker = createCodexCapacityNoticeTracker()
    const readScreen = () => [`⚠ ${CODEX_CAPACITY_MESSAGE}`, '›']
    expect(tracker.observe('⚠ 1 warning · f2 to view', readScreen)).toBe(false)
    expect(tracker.observe('⚠ Selected model is ', readScreen)).toBe(false)
    expect(tracker.observe('at capacity. Please try a different model.', readScreen)).toBe(true)
  })

  it('keeps a notice seen while the screen is untrusted past any noise, dated from its first piece', () => {
    const tracker = createCodexCapacityNoticeTracker()
    const readScreen = () => [`■ ${CODEX_CAPACITY_MESSAGE}`, '›']
    expect(tracker.observe('■ Selected model is ', readScreen, () => false, 3, false)).toBe(false)
    expect(
      tracker.observe(
        'at capacity. Please try a different model.',
        readScreen,
        () => false,
        4,
        false
      )
    ).toBe(false)
    for (let i = 0; i < 8_193; i++) {
      tracker.observe('\x1b[0m', readScreen, () => false, 5, false)
    }
    expect(tracker.observe('', readScreen, () => false, 9)).toBe(true)
    expect(tracker.pendingAt).toBe(3)
  })
})
