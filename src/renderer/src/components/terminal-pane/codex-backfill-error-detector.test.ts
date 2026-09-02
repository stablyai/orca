import { describe, expect, it } from 'vitest'
import {
  CODEX_BACKFILL_RECOVERY_NOTICE,
  createCodexBackfillErrorDetector
} from './codex-backfill-error-detector'

describe('Codex backfill error detector', () => {
  it('recognizes the timeout across ANSI-decorated chunks once', () => {
    const detector = createCodexBackfillErrorDetector()

    expect(detector.observe('\u001b[31mError: timed out waiting for state DB back')).toBeNull()
    expect(detector.observe('fill\u001b[0m\r\n')).toBe(CODEX_BACKFILL_RECOVERY_NOTICE)
    expect(detector.observe('timed out waiting for state db backfill')).toBeNull()
  })

  it('does not classify the generic damaged-database message', () => {
    const detector = createCodexBackfillErrorDetector()

    expect(detector.observe('local database appears to be damaged')).toBeNull()
  })
})
