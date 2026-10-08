import { advanceTerminalEscapeBoundary } from '../../../../shared/terminal-partial-escape-tail'
import { RESET_TERMINAL_CURSOR_STYLE } from '../../../../shared/terminal-mode-reset-profiles'

/** Cosmetic resets must not abort an application's unfinished control sequence. */
export class TerminalIdleCursorReset {
  private escapeState = ''
  private pending = false
  private resetParsed: (() => void) | undefined

  request(): string {
    this.pending = true
    return this.takeReadyReset()
  }

  processOutput(data: string): string {
    this.escapeState = advanceTerminalEscapeBoundary(this.escapeState, data)
    const reset = this.takeReadyReset()
    return reset ? `${data}${reset}` : data
  }

  cancelSequence(): string {
    this.escapeState = ''
    this.pending ||= this.resetParsed !== undefined
    return this.takeReadyReset()
  }

  getResetParsedCallback(): (() => void) | undefined {
    return this.resetParsed
  }

  private takeReadyReset(): string {
    if (!this.pending || this.escapeState) {
      return ''
    }
    this.pending = false
    const resetParsed = (): void => {
      // Why: an older completion must not clear a replacement reset's delivery intent.
      if (this.resetParsed === resetParsed) {
        this.resetParsed = undefined
      }
    }
    this.resetParsed = resetParsed
    return RESET_TERMINAL_CURSOR_STYLE
  }
}
