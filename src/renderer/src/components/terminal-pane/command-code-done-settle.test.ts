import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMMAND_CODE_OUTPUT_DONE_SETTLE_MS,
  _resetCommandCodeDoneSettlesForTest,
  cancelCommandCodeDoneSettle,
  openCommandCodeDoneSettle,
  setCommandCodeDoneSettleExecutor
} from './command-code-done-settle'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const OTHER_PANE_KEY = 'tab-2:22222222-2222-4222-8222-222222222222'

describe('command code done settle window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetCommandCodeDoneSettlesForTest()
  })

  afterEach(() => {
    _resetCommandCodeDoneSettlesForTest()
    vi.useRealTimers()
  })

  it('settles through the registered executor at the deadline', () => {
    const settle = vi.fn()
    setCommandCodeDoneSettleExecutor(PANE_KEY, settle)

    openCommandCodeDoneSettle(PANE_KEY, 'Fix the spinner')
    vi.advanceTimersByTime(COMMAND_CODE_OUTPUT_DONE_SETTLE_MS - 1)
    expect(settle).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(settle).toHaveBeenCalledExactlyOnceWith('Fix the spinner')
  })

  // Why: this is the park/reveal contract — the deadline is the turn's, not the owner's.
  it('keeps the original deadline when the owner is swapped mid-window', () => {
    const parkedWatcherSettle = vi.fn()
    const releaseParkedWatcher = setCommandCodeDoneSettleExecutor(PANE_KEY, parkedWatcherSettle)

    openCommandCodeDoneSettle(PANE_KEY, 'Fix the spinner')
    vi.advanceTimersByTime(COMMAND_CODE_OUTPUT_DONE_SETTLE_MS - 100)

    // Reveal: the remounted pane registers before the parked watcher releases.
    const revealedPaneSettle = vi.fn()
    setCommandCodeDoneSettleExecutor(PANE_KEY, revealedPaneSettle)
    releaseParkedWatcher()

    vi.advanceTimersByTime(100)
    expect(parkedWatcherSettle).not.toHaveBeenCalled()
    expect(revealedPaneSettle).toHaveBeenCalledExactlyOnceWith('Fix the spinner')
  })

  // Why identity-checked: a late release from the previous owner must not unregister the successor.
  it('ignores a stale release once a successor has registered', () => {
    const releaseFirst = setCommandCodeDoneSettleExecutor(PANE_KEY, vi.fn())
    const successorSettle = vi.fn()
    setCommandCodeDoneSettleExecutor(PANE_KEY, successorSettle)
    releaseFirst()

    openCommandCodeDoneSettle(PANE_KEY, 'Fix the spinner')
    vi.advanceTimersByTime(COMMAND_CODE_OUTPUT_DONE_SETTLE_MS)

    expect(successorSettle).toHaveBeenCalledExactlyOnceWith('Fix the spinner')
  })

  it('drops the window when a working repaint cancels it', () => {
    const settle = vi.fn()
    setCommandCodeDoneSettleExecutor(PANE_KEY, settle)

    openCommandCodeDoneSettle(PANE_KEY, 'Fix the spinner')
    cancelCommandCodeDoneSettle(PANE_KEY)
    vi.advanceTimersByTime(COMMAND_CODE_OUTPUT_DONE_SETTLE_MS * 2)

    expect(settle).not.toHaveBeenCalled()
  })

  // Why: a pane torn down with no successor has no row worth completing.
  it('fires harmlessly when every owner released before the deadline', () => {
    const release = setCommandCodeDoneSettleExecutor(PANE_KEY, vi.fn())
    openCommandCodeDoneSettle(PANE_KEY, 'Fix the spinner')
    release()

    expect(() => vi.advanceTimersByTime(COMMAND_CODE_OUTPUT_DONE_SETTLE_MS)).not.toThrow()
  })

  it('re-opening replaces the pending window rather than stacking a second one', () => {
    const settle = vi.fn()
    setCommandCodeDoneSettleExecutor(PANE_KEY, settle)

    openCommandCodeDoneSettle(PANE_KEY, 'first turn')
    vi.advanceTimersByTime(COMMAND_CODE_OUTPUT_DONE_SETTLE_MS - 100)
    openCommandCodeDoneSettle(PANE_KEY, 'second turn')
    vi.advanceTimersByTime(COMMAND_CODE_OUTPUT_DONE_SETTLE_MS)

    expect(settle).toHaveBeenCalledExactlyOnceWith('second turn')
  })

  it('scopes windows per pane key', () => {
    const settle = vi.fn()
    const otherSettle = vi.fn()
    setCommandCodeDoneSettleExecutor(PANE_KEY, settle)
    setCommandCodeDoneSettleExecutor(OTHER_PANE_KEY, otherSettle)

    openCommandCodeDoneSettle(PANE_KEY, 'mine')
    openCommandCodeDoneSettle(OTHER_PANE_KEY, 'theirs')
    cancelCommandCodeDoneSettle(PANE_KEY)
    vi.advanceTimersByTime(COMMAND_CODE_OUTPUT_DONE_SETTLE_MS)

    expect(settle).not.toHaveBeenCalled()
    expect(otherSettle).toHaveBeenCalledExactlyOnceWith('theirs')
  })
})
