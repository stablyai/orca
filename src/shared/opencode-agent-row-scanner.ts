/**
 * OpenCode's submit readiness: the `<agent> · <model>` row along the bottom of its input box is
 * painted only once its agent list has loaded from its server, and until then it drops an Enter.
 *
 * Read off the stream by structure, never by names or colours: the row's separator `·` (U+00B7)
 * sits on the line directly above the box's bottom-left corner `╹` (U+2579), both placed by
 * absolute cursor addressing inside OpenCode's alternate screen. The footer path below the box and
 * the session tab strip above it can hold `·` too; neither is on that line. OpenCode 2 paints the
 * corner first and the row in a later frame; OpenCode 1 paints the row just before the corner in
 * the same synchronized frame, so a separator waits for its corner until that frame ends.
 *
 * Ready once the row exists and the box's cursor is shown while bracketed paste is held (the
 * earlier box rule), so neither version is delivered to sooner than before. Leaving the alternate
 * screen or turning bracketed paste off withdraws what it established.
 */

const ESC = '\x1b'
const AGENT_ROW_SEPARATOR = '\u00b7'
const BOX_BOTTOM_LEFT = '\u2579'
// Why: a narrow pane never paints the row (OpenCode 2 drops the agent below 44 columns), and nor
// does a terminal that does not forward the alternate screen; a theme whose raised background is
// transparent paints no `╹`, so its starts always wait out the grace. Once the box's cursor has shown, the
// earlier box rule takes over after this grace, so those starts still get their task, as before.
// 5 s because the row trailed the box by at most 1.8 s in every recorded start, loaded or not.
export const OPENCODE_AGENT_ROW_GRACE_MS = 5_000
// Longest unfinished escape carried into the next read; anything longer is noise, not a split.
const MAX_CARRIED_ESCAPE_CHARS = 512

/* oxlint-disable no-control-regex -- these match terminal escape sequences, which start with ESC */
const CSI_RE = /^\x1b\[([?>=<]?)([0-9;]*)([ -/]*[@-~])/
const UNFINISHED_CSI_RE = /^\x1b\[[?>=<]?[0-9;]*[ -/]*$/
// OSC and DCS strings (titles, queries) end at BEL or ST; their text is never painted.
const STRING_RE = /^\x1b[\]P][^\x07\x1b]*(?:\x07|\x1b\\)/
const STRING_START_RE = /^\x1b[\]P]/
const STRING_END_RE = /\x07|\x1b\\/

export type OpenCodeAgentRowScan = {
  /** The row exists and the box's cursor is shown: Enter will be taken. */
  ready: boolean
  /** Box shown, no row yet: ready after this many ms unless the row comes first; null withdraws. */
  readyAfterMs: number | null
}

export function createOpenCodeAgentRowScanner(): {
  observe: (data: string) => OpenCodeAgentRowScan
} {
  let carry = ''
  let altScreen = false
  // Once a full-screen app has left, a box cursor outside the alternate screen is the shell's.
  let leftAltScreen = false
  let bracketedPaste = false
  let boxCursorShown = false
  let row: number | null = null
  let boxBottomRow: number | null = null
  let rowPainted = false
  // Separator rows seen in the open synchronized frame, for OpenCode 1's row-before-corner order.
  let framePendingRows = new Set<number>()

  const resetLayout = (): void => {
    row = null
    boxBottomRow = null
    rowPainted = false
    framePendingRows = new Set()
  }

  const onPrivateMode = (mode: string, set: boolean): void => {
    if (mode === '1049') {
      altScreen = set
      resetLayout()
      if (!set) {
        leftAltScreen = true
        boxCursorShown = false
      }
    } else if (mode === '2004') {
      bracketedPaste = set
      if (!set) {
        boxCursorShown = false
      }
    } else if (mode === '25' && set && bracketedPaste) {
      boxCursorShown = true
    } else if (mode === '2026') {
      framePendingRows = new Set()
    }
  }

  const onCsi = (privateMarker: string, params: string, final: string): void => {
    if (privateMarker === '?' && (final === 'h' || final === 'l')) {
      for (const mode of params.split(';')) {
        onPrivateMode(mode, final === 'h')
      }
    } else if (final === 'H' || final === 'f') {
      row = Math.max(1, Number(params.split(';')[0] || '1'))
    } else if (final === 'J' && params === '2') {
      boxBottomRow = null
      framePendingRows = new Set()
    }
  }

  const onText = (text: string): void => {
    if (!altScreen || row === null) {
      return
    }
    for (const char of text) {
      if (char === '\n') {
        row += 1
      } else if (char === AGENT_ROW_SEPARATOR) {
        if (boxBottomRow === row + 1) {
          rowPainted = true
        } else {
          framePendingRows.add(row)
        }
      } else if (char === BOX_BOTTOM_LEFT) {
        boxBottomRow = row
        if (framePendingRows.has(row - 1)) {
          rowPainted = true
        }
      }
    }
  }

  return {
    observe(data: string): OpenCodeAgentRowScan {
      const input = carry + data
      carry = ''
      let index = 0
      while (index < input.length) {
        const escapeAt = input.indexOf(ESC, index)
        if (escapeAt === -1) {
          onText(input.slice(index))
          break
        }
        onText(input.slice(index, escapeAt))
        const rest = input.slice(escapeAt)
        const sequence = CSI_RE.exec(rest) ?? STRING_RE.exec(rest)
        if (sequence) {
          if (sequence[0][1] === '[') {
            onCsi(sequence[1], sequence[2], sequence[3])
          }
          index = escapeAt + sequence[0].length
          continue
        }
        if (isUnfinishedEscape(rest)) {
          carry = rest
          break
        }
        index = escapeAt + 2
      }
      // Leaving the alternate screen clears rowPainted, so it only holds while OpenCode is drawn.
      const graceApplies = boxCursorShown && !rowPainted && (altScreen || !leftAltScreen)
      return {
        ready: rowPainted && boxCursorShown,
        readyAfterMs: graceApplies ? OPENCODE_AGENT_ROW_GRACE_MS : null
      }
    }
  }
}

function isUnfinishedEscape(rest: string): boolean {
  if (rest.length > MAX_CARRIED_ESCAPE_CHARS) {
    return false
  }
  return (
    rest === ESC ||
    UNFINISHED_CSI_RE.test(rest) ||
    (STRING_START_RE.test(rest) && !STRING_END_RE.test(rest))
  )
}
