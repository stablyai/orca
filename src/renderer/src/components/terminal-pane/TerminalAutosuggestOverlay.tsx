import type { Terminal } from '@xterm/xterm'
import { cellToPixelPosition } from './terminal-autosuggest-cell-position'
import { hexToRgba, isHexColor } from './terminal-appearance'

type TerminalAutosuggestOverlayProps = {
  terminal: Terminal
  row: number
  cursorCol: number
  suggestionRemainder: string
  foregroundColor: string
}

const GHOST_TEXT_OPACITY = 0.4

export function TerminalAutosuggestOverlay({
  terminal,
  row,
  cursorCol,
  suggestionRemainder,
  foregroundColor
}: TerminalAutosuggestOverlayProps): React.JSX.Element | null {
  if (suggestionRemainder.length === 0) {
    return null
  }
  const position = cellToPixelPosition(terminal, row, cursorCol)
  if (!position) {
    return null
  }
  // Why: foregroundColor may be a named CSS color (not hex) when it comes from
  // a theme override; hexToRgba would produce garbage on non-hex input.
  const color = isHexColor(foregroundColor)
    ? hexToRgba(foregroundColor, GHOST_TEXT_OPACITY)
    : foregroundColor
  return (
    <div
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        color,
        pointerEvents: 'none',
        whiteSpace: 'pre',
        fontFamily: 'inherit'
      }}
    >
      {suggestionRemainder}
    </div>
  )
}
