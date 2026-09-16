import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { TerminalImeBoundaryTrace } from './terminal-ime-boundary-probe'

/** Kept identical to config/scripts/terminal-ime-engagement-receipt.mjs; pinned by a contract test. */
const IME_ENGAGEMENT_RECEIPT_ENV = 'ORCA_E2E_IME_ENGAGEMENT_RECEIPT'

const HANGUL_SYLLABLE = /[\uac00-\ud7af]/

/**
 * Records that a real input method composed text during this test. Only the session runner sets
 * the receipt path, so a spec run by hand or by the generic changed-spec lane writes nothing.
 */
export function appendImeEngagementReceipt(
  testTitle: string,
  trace: TerminalImeBoundaryTrace
): void {
  const receiptPath = process.env[IME_ENGAGEMENT_RECEIPT_ENV]
  if (!receiptPath) {
    return
  }
  const entry = {
    test: testTitle,
    compositionStart: trace.dom.filter((event) => event.type === 'compositionstart').length,
    hangulComposition: trace.dom.filter(
      (event) =>
        (event.type === 'compositionupdate' ||
          (event.type === 'input' && event.inputType === 'insertText')) &&
        HANGUL_SYLLABLE.test(event.data ?? '')
    ).length,
    onDataChunks: trace.onData.length
  }
  mkdirSync(path.dirname(receiptPath), { recursive: true })
  appendFileSync(receiptPath, `${JSON.stringify(entry)}\n`)
}
