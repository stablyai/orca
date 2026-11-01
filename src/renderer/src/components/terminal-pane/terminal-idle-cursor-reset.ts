import { advanceTerminalEscapeBoundary } from '../../../../shared/terminal-partial-escape-tail'
import { RESET_TERMINAL_CURSOR_STYLE } from '../../../../shared/terminal-mode-reset-profiles'

/** Cosmetic resets must not abort an application's unfinished control sequence. */
export class TerminalIdleCursorReset {
  private escapeState = ''
  private pending = false

  request(): string {
    this.pending = true
    return this.takeReadyReset()
  }

  processOutput(data: string): string {
    this.escapeState = advanceTerminalEscapeBoundary(this.escapeState, data)
    const reset = this.takeReadyReset()
    return reset ? `${data}${reset}` : data
  }

  private takeReadyReset(): string {
    if (!this.pending || this.escapeState) {
      return ''
    }
    this.pending = false
    return RESET_TERMINAL_CURSOR_STYLE
  }
}
