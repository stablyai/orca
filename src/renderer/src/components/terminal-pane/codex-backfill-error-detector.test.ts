import { describe, expect, it } from 'vitest'
import {
  CODEX_BACKFILL_RECOVERY_NOTICE,
  CODEX_BACKFILL_SCAN_BUDGET_CHARS,
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

  it('still fires when the signature lands inside the scan budget', () => {
    const detector = createCodexBackfillErrorDetector()
    const filler = 'x'.repeat(1024)
    const chunksBeforeSignature = Math.floor(CODEX_BACKFILL_SCAN_BUDGET_CHARS / filler.length) - 1
    for (let index = 0; index < chunksBeforeSignature; index++) {
      expect(detector.observe(filler)).toBeNull()
    }
    expect(detector.observe('Error: timed out waiting for state DB backfill\r\n')).toBe(
      CODEX_BACKFILL_RECOVERY_NOTICE
    )
  })

  it('disarms once the budget is spent so a later signature is ignored', () => {
    const detector = createCodexBackfillErrorDetector()
    expect(detector.observe('x'.repeat(CODEX_BACKFILL_SCAN_BUDGET_CHARS))).toBeNull()
    expect(detector.observe('Error: timed out waiting for state DB backfill\r\n')).toBeNull()
  })

  it('charges raw chunk length, so escape-heavy output cannot extend the scan', () => {
    const detector = createCodexBackfillErrorDetector()
    const escapes = '\u001b[0m'.repeat(CODEX_BACKFILL_SCAN_BUDGET_CHARS / 4)
    expect(detector.observe(escapes)).toBeNull()
    expect(detector.observe('timed out waiting for state db backfill')).toBeNull()
  })
})
