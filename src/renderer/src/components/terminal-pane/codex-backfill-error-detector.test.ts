import { describe, expect, it } from 'vitest'
import {
  CODEX_BACKFILL_INDEXING_NOTICE,
  createCodexBackfillErrorDetector
} from './codex-backfill-error-detector'

const FAILURE_OUTPUT =
  'state db backfill is running at /home/dan/.local/share/orca/codex-runtime-home/home; ' +
  'waiting up to 30s before retrying startup initialization\r\n' +
  "Codex couldn't start because its local database appears to be damaged.\r\n" +
  'timed out waiting for state db backfill at ' +
  '/home/dan/.local/share/orca/codex-runtime-home/home/state_5.sqlite after 30s (status: running)\r\n'

describe('createCodexBackfillErrorDetector', () => {
  it('fires the notice when the timeout signature appears in one chunk', () => {
    const detector = createCodexBackfillErrorDetector()
    expect(detector.observe(FAILURE_OUTPUT)).toBe(CODEX_BACKFILL_INDEXING_NOTICE)
  })

  it('fires when the signature is split across chunks', () => {
    const detector = createCodexBackfillErrorDetector()
    const mid = Math.floor(FAILURE_OUTPUT.length / 2)
    expect(detector.observe(FAILURE_OUTPUT.slice(0, mid))).toBeNull()
    expect(detector.observe(FAILURE_OUTPUT.slice(mid))).toBe(CODEX_BACKFILL_INDEXING_NOTICE)
  })

  it('fires despite interleaved ANSI escapes', () => {
    const detector = createCodexBackfillErrorDetector()
    const noisy = FAILURE_OUTPUT.replace(/state db/g, '\u001b[31mstate\u001b[0m db')
    expect(detector.observe(noisy)).toBe(CODEX_BACKFILL_INDEXING_NOTICE)
  })

  it('fires at most once', () => {
    const detector = createCodexBackfillErrorDetector()
    expect(detector.observe(FAILURE_OUTPUT)).toBe(CODEX_BACKFILL_INDEXING_NOTICE)
    expect(detector.observe(FAILURE_OUTPUT)).toBeNull()
  })

  it('stays silent for ordinary output and for the non-fatal waiting line alone', () => {
    const detector = createCodexBackfillErrorDetector()
    expect(detector.observe('hello world\r\n')).toBeNull()
    expect(
      detector.observe('state db backfill is running at /x; waiting up to 30s before retrying\r\n')
    ).toBeNull()
  })

  it('does not fire on a generic damaged-database error without the backfill timeout', () => {
    const detector = createCodexBackfillErrorDetector()
    expect(
      detector.observe("Codex couldn't start because its local database appears to be damaged.\r\n")
    ).toBeNull()
  })
})
