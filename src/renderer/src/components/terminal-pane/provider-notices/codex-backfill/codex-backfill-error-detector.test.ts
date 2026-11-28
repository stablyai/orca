import { describe, expect, it } from 'vitest'
import {
  CODEX_BACKFILL_RECOVERY_NOTICE,
  CODEX_BACKFILL_TIMEOUT_SIGNATURE,
  createCodexBackfillErrorDetector
} from './codex-backfill-error-detector'

describe('createCodexBackfillErrorDetector', () => {
  it('ignores large Kitty APC payloads without dropping split timeout signatures or CSI/OSC stripping', () => {
    const detector = createCodexBackfillErrorDetector()
    const half = Math.floor(CODEX_BACKFILL_TIMEOUT_SIGNATURE.length / 2)
    const firstHalf = CODEX_BACKFILL_TIMEOUT_SIGNATURE.slice(0, half)
    const secondHalf = CODEX_BACKFILL_TIMEOUT_SIGNATURE.slice(half)

    expect(detector.observe(`prefix \x1b[31m${firstHalf}\x1b`)).toBeNull()
    expect(detector.observe(`_Ga=T,f=100;${'A'.repeat(65536)}\x1b`)).toBeNull()
    expect(detector.observe(`\\\x1b[0m\x1b]0;title\x07${secondHalf}\r\nsuffix`)).toBe(
      CODEX_BACKFILL_RECOVERY_NOTICE
    )
    expect(detector.observe(CODEX_BACKFILL_TIMEOUT_SIGNATURE)).toBeNull()
  })

  it('handles split CSI ESC and CAN/SUB control-string aborts across chunks', () => {
    const detector = createCodexBackfillErrorDetector()
    expect(detector.observe('Error: \x1b')).toBeNull()
    expect(detector.observe(`[31m${CODEX_BACKFILL_TIMEOUT_SIGNATURE}`)).toBe(
      CODEX_BACKFILL_RECOVERY_NOTICE
    )

    const canDetector = createCodexBackfillErrorDetector()
    expect(canDetector.observe('\x1b_Ga=T,f=100;AAAA')).toBeNull()
    expect(canDetector.observe(`\x18Error: ${CODEX_BACKFILL_TIMEOUT_SIGNATURE}`)).toBe(
      CODEX_BACKFILL_RECOVERY_NOTICE
    )

    const subDetector = createCodexBackfillErrorDetector()
    expect(subDetector.observe('\x1b_Ga=T,f=100;BBBB\x1b')).toBeNull()
    expect(subDetector.observe(`\x1aError: ${CODEX_BACKFILL_TIMEOUT_SIGNATURE}`)).toBe(
      CODEX_BACKFILL_RECOVERY_NOTICE
    )

    const doubleEscSingleChunk = createCodexBackfillErrorDetector()
    expect(
      doubleEscSingleChunk.observe(`\x1b\x1b_G${CODEX_BACKFILL_TIMEOUT_SIGNATURE}\x1b\\`)
    ).toBeNull()

    const doubleEscSplitChunk = createCodexBackfillErrorDetector()
    expect(doubleEscSplitChunk.observe('\x1b')).toBeNull()
    expect(
      doubleEscSplitChunk.observe(`\x1b_G${CODEX_BACKFILL_TIMEOUT_SIGNATURE}\x1b\\`)
    ).toBeNull()
  })
})
