/**
 * Memory-leak regression: `warnedLostHandlerPtyIds` outlived the buffered data it
 * describes when the LRU cap evicted that data.
 *
 * The set is cleaned in `drainPreHandlerPtyData` and `clearPreHandlerPtyState`,
 * which both mean "a pane took this PTY's bytes". `evictOldestPtyIfAtCap` drops
 * the oldest data entry without either, so a PTY that warned and was then evicted
 * left its id behind for the life of the renderer — and, because the warn is
 * once-per-id, silently suppressed the warning for a fresh accumulation on that
 * same id, which is the exact signal the breadcrumb exists to emit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bufferPreHandlerPtyData, clearPreHandlerPtyState } from './pty-pre-handler-buffer'

const PRE_HANDLER_PTY_DATA_MAX_PTYS = 64
const WARN_BYTES = 64 * 1024
const EVICTED_PTY_ID = 'pty-warn-evicted'
/** One more than the cap, so the first id admitted is evicted. */
const FILLER_PTY_IDS = Array.from(
  { length: PRE_HANDLER_PTY_DATA_MAX_PTYS },
  (_, index) => `pty-warn-filler-${index}`
)

function bufferPastWarnThreshold(ptyId: string): void {
  bufferPreHandlerPtyData(ptyId, 'x'.repeat(WARN_BYTES + 1))
}

function lostHandlerWarnings(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes('with no registered data handler'))
}

afterEach(() => {
  vi.restoreAllMocks()
  clearPreHandlerPtyState(EVICTED_PTY_ID)
  for (const ptyId of FILLER_PTY_IDS) {
    clearPreHandlerPtyState(ptyId)
  }
})

describe('pre-handler lost-handler warning after LRU eviction', () => {
  it('warns again once the evicted PTY re-accumulates past the threshold', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    bufferPastWarnThreshold(EVICTED_PTY_ID)
    expect(lostHandlerWarnings(warn)).toHaveLength(1)

    // Push the warned id out of the data map through the LRU cap.
    for (const ptyId of FILLER_PTY_IDS) {
      bufferPreHandlerPtyData(ptyId, 'y')
    }

    // Its buffered bytes are gone, so this is a brand-new accumulation episode.
    bufferPastWarnThreshold(EVICTED_PTY_ID)

    const messages = lostHandlerWarnings(warn)
    expect(messages).toHaveLength(2)
    expect(messages[1]).toContain(EVICTED_PTY_ID)
  })

  it('still warns only once while the buffered data is retained', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    bufferPastWarnThreshold(EVICTED_PTY_ID)
    bufferPastWarnThreshold(EVICTED_PTY_ID)
    bufferPastWarnThreshold(EVICTED_PTY_ID)

    expect(lostHandlerWarnings(warn)).toHaveLength(1)
  })
})
