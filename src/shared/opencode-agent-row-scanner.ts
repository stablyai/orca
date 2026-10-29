import { createTerminalEscapeScanner } from './terminal-escape-scanner'

/** OpenCode drops Enter until its agent/model row loads. Detect · above bottom-left ╹ via alternate-screen cursor coordinates,
 * never names/colors: footer/tab separators are unrelated. OpenCode 2 paints corner before row; v1 paints row before corner within one synchronized frame.
 * Require row plus shown box cursor while bracketed paste is enabled. Leaving alternate screen/disabling paste revokes readiness. */

const AGENT_ROW_SEPARATOR = '\u00b7'
const BOX_BOTTOM_LEFT = '\u2579'
// Narrow panes and transparent themes omit the row; retain the earlier box signal after a grace.
export const OPENCODE_AGENT_ROW_GRACE_MS = 5_000

export type OpenCodeAgentRowScan = {
  /** The row exists and the box's cursor is shown: Enter will be taken. */
  ready: boolean
  /** Box shown, no row yet: ready after this many ms unless the row comes first; null withdraws. */
  readyAfterMs: number | null
}

export function createOpenCodeAgentRowScanner(): {
  observe: (data: string) => OpenCodeAgentRowScan
} {
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

  const scanner = createTerminalEscapeScanner({ onCsi, onText })
  return {
    observe(data: string): OpenCodeAgentRowScan {
      scanner.observe(data)
      // Leaving the alternate screen clears rowPainted, so it only holds while OpenCode is drawn.
      const graceApplies = boxCursorShown && !rowPainted && (altScreen || !leftAltScreen)
      return {
        ready: rowPainted && boxCursorShown,
        readyAfterMs: graceApplies ? OPENCODE_AGENT_ROW_GRACE_MS : null
      }
    }
  }
}
