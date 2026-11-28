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

const ESC = '\u001b'
// eslint-disable-next-line no-control-regex -- VT500 control strings end or abort on CAN, SUB, or ESC
const CONTROL_STRING_EVENT_RE = /[\u0018\u001a\u001b]/g

function isNonOscControlStringIntroducer(code: number): boolean {
  // DCS (P), SOS (X), PM (^), APC (_); leave CSI ([) and OSC (]) for ANSI_ESCAPE_PATTERN.
  return code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f
}

/** Incrementally drops APC/DCS/PM/SOS control strings so Kitty image bursts skip regex scans without hiding split text. */
function createControlStringStripper(): (chunk: string) => string {
  let inControlString = false
  let trailingEsc = false
  return (chunk: string): string => {
    if (chunk.length === 0) {
      return ''
    }
    if (!inControlString && !trailingEsc && !chunk.includes(ESC)) {
      return chunk
    }
    let out = ''
    let scanFrom = 0
    let segmentStart = 0
    if (trailingEsc) {
      trailingEsc = false
      const first = chunk.charCodeAt(0)
      if (inControlString) {
        if (
          first === 0x5c ||
          first === 0x18 ||
          first === 0x1a ||
          isNonOscControlStringIntroducer(first)
        ) {
          inControlString = isNonOscControlStringIntroducer(first)
          scanFrom = 1
          segmentStart = 1
        } else if (first !== 0x1b) {
          inControlString = false
          out = ESC
        }
      } else if (isNonOscControlStringIntroducer(first)) {
        inControlString = true
        scanFrom = 1
        segmentStart = 1
      } else {
        out = ESC
      }
    }

    while (scanFrom < chunk.length) {
      if (inControlString) {
        CONTROL_STRING_EVENT_RE.lastIndex = scanFrom
        const match = CONTROL_STRING_EVENT_RE.exec(chunk)
        if (!match) {
          break
        }
        const at = match.index
        const code = chunk.charCodeAt(at)
        if (code === 0x18 || code === 0x1a) {
          inControlString = false
          scanFrom = at + 1
          segmentStart = scanFrom
          continue
        }
        if (at + 1 >= chunk.length) {
          trailingEsc = true
          return out
        }
        const next = chunk.charCodeAt(at + 1)
        if (next === 0x5c || next === 0x18 || next === 0x1a) {
          inControlString = false
          scanFrom = at + 2
          segmentStart = scanFrom
        } else if (next === 0x1b || isNonOscControlStringIntroducer(next)) {
          scanFrom = at + (next === 0x1b ? 1 : 2)
        } else {
          inControlString = false
          segmentStart = at
          scanFrom = at + 2
        }
        continue
      }
      const escAt = chunk.indexOf(ESC, scanFrom)
      if (escAt === -1) {
        break
      }
      if (escAt + 1 >= chunk.length) {
        out += chunk.slice(segmentStart, escAt)
        segmentStart = chunk.length
        trailingEsc = true
        return out
      }
      const next = chunk.charCodeAt(escAt + 1)
      if (isNonOscControlStringIntroducer(next)) {
        out += chunk.slice(segmentStart, escAt)
        inControlString = true
        scanFrom = escAt + 2
        segmentStart = scanFrom
        continue
      }
      scanFrom = escAt + (next === 0x1b ? 1 : 2)
    }

    if (inControlString) {
      return out
    }
    return segmentStart === 0 && out === '' ? chunk : out + chunk.slice(segmentStart)
  }
}

/** Scans one Codex pane's output once for the unambiguous backfill timeout. */
export function createCodexBackfillErrorDetector(): CodexBackfillErrorDetector {
  let tail = ''
  let armed = true
  const stripControlStrings = createControlStringStripper()
  return {
    observe(chunk: string): string | null {
      if (!armed) {
        return null
      }
      const stripped = stripControlStrings(chunk)
      if (stripped.length === 0) {
        return null
      }
      const normalized = (tail + stripped).replace(ANSI_ESCAPE_PATTERN, '').replace(/\r/g, '')
      tail = normalized.slice(-DETECTOR_BUFFER_MAX_CHARS)
      if (!CODEX_BACKFILL_TIMEOUT_PATTERN.test(tail)) {
        return null
      }
      armed = false
      return CODEX_BACKFILL_RECOVERY_NOTICE
    }
  }
}
