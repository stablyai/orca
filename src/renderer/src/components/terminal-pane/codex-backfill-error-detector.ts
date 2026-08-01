// Why: 'database appears to be damaged' alone can be a real corruption; only the
// backfill-timeout line is unambiguous for the #11828 large-history startup race.
export const CODEX_BACKFILL_TIMEOUT_SIGNATURE = 'timed out waiting for state db backfill'

export const CODEX_BACKFILL_INDEXING_NOTICE = [
  'Codex is still indexing your session history and could not start yet.',
  'Codex reports this as a damaged local database, but the database is fine — its one-time session index takes a while on a large history and Codex only waits 30 seconds at startup.',
  // Why the hedged phrasing: not every configuration gets the background prewarm
  // (ledger AD-3); leaving a codex pane open also finishes the index (codex resumes
  // the claim itself), so the advice must be honest for all lanes.
  'Orca finishes the index in the background when it can; leaving one Codex pane open also lets Codex finish it. Retry in a few minutes.'
].join('\n')

// Why: strip CSI/OSC escapes so a redraw-heavy TUI cannot split the signature text.
const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex -- terminal escape sequences require control chars
  /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g
const DETECTOR_BUFFER_MAX_CHARS = 4096

export type CodexBackfillErrorDetector = { observe(chunk: string): string | null }

/** One-shot scanner over a pane's output stream for Codex's backfill-timeout failure. */
export function createCodexBackfillErrorDetector(): CodexBackfillErrorDetector {
  let tail = ''
  let armed = true
  return {
    observe(chunk: string): string | null {
      if (!armed) {
        return null
      }
      const normalized = (tail + chunk).replace(ANSI_ESCAPE_PATTERN, '').replace(/\r/g, '')
      tail = normalized.slice(-DETECTOR_BUFFER_MAX_CHARS)
      if (!tail.includes(CODEX_BACKFILL_TIMEOUT_SIGNATURE)) {
        return null
      }
      armed = false
      return CODEX_BACKFILL_INDEXING_NOTICE
    }
  }
}
