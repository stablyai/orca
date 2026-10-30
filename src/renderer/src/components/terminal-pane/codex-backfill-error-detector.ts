export const CODEX_BACKFILL_TIMEOUT_SIGNATURE = 'timed out waiting for state db backfill'

export const CODEX_BACKFILL_RECOVERY_NOTICE = [
  'Codex could not start because its session-history index is still incomplete.',
  'Keep Orca open for a few minutes, then retry this pane. Orca attempts background recovery for managed local and WSL homes.'
].join('\n')

const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex -- terminal escape sequences contain control bytes
  /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g
const DETECTOR_BUFFER_MAX_CHARS = 4096
// Why a regex over toLowerCase(): the case-folded copy allocated the whole 4KB carry on every chunk.
const CODEX_BACKFILL_TIMEOUT_PATTERN = new RegExp(CODEX_BACKFILL_TIMEOUT_SIGNATURE, 'i')

export type CodexBackfillErrorDetector = { observe(chunk: string): string | null }

/** Scans one Codex pane's output once for the unambiguous backfill timeout. */
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
      if (!CODEX_BACKFILL_TIMEOUT_PATTERN.test(tail)) {
        return null
      }
      armed = false
      return CODEX_BACKFILL_RECOVERY_NOTICE
    }
  }
}
