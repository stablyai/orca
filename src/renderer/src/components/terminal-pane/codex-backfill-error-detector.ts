export const CODEX_BACKFILL_TIMEOUT_SIGNATURE = 'timed out waiting for state db backfill'

export const CODEX_BACKFILL_RECOVERY_NOTICE = [
  'Codex could not start because its session-history index is still incomplete.',
  'Keep Orca open for a few minutes, then retry this pane. Orca attempts background recovery for managed local and WSL homes.'
].join('\n')

const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex -- terminal escape sequences contain control bytes
  /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g
const DETECTOR_BUFFER_MAX_CHARS = 4096
/**
 * Raw output after which the scan disarms. Codex prints the timeout from its
 * state-db startup gate, before the TUI ever draws, so it can only appear in
 * the first few KB of a pane's output; without a budget every later chunk is
 * stripped and copied for the pane's whole life.
 */
export const CODEX_BACKFILL_SCAN_BUDGET_CHARS = 256 * 1024

export type CodexBackfillErrorDetector = { observe(chunk: string): string | null }

/** Scans the start of one Codex pane's output once for the unambiguous backfill timeout. */
export function createCodexBackfillErrorDetector(): CodexBackfillErrorDetector {
  let tail = ''
  let armed = true
  let observedChars = 0
  return {
    observe(chunk: string): string | null {
      if (!armed) {
        return null
      }
      const normalized = (tail + chunk).replace(ANSI_ESCAPE_PATTERN, '').replace(/\r/g, '')
      tail = normalized.slice(-DETECTOR_BUFFER_MAX_CHARS)
      observedChars += chunk.length
      if (!tail.toLowerCase().includes(CODEX_BACKFILL_TIMEOUT_SIGNATURE)) {
        if (observedChars >= CODEX_BACKFILL_SCAN_BUDGET_CHARS) {
          armed = false
          tail = ''
        }
        return null
      }
      armed = false
      tail = ''
      return CODEX_BACKFILL_RECOVERY_NOTICE
    }
  }
}
