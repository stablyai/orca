export type TerminalCursorSuppressionTarget = {
  element?: { classList?: Pick<DOMTokenList, 'add' | 'remove'> | null } | null
}

const FOREGROUND_CURSOR_RESTORE_DELAY_MS = 64
const FOREGROUND_CURSOR_RESTORE_SAFETY_MS = 500

export const FOREGROUND_CURSOR_SUPPRESSED_CLASS = 'terminal-foreground-write-pending'
export const FOREGROUND_CURSOR_RESTORE_SAFETY_DELAY_MS = FOREGROUND_CURSOR_RESTORE_SAFETY_MS

const restoreTimerByTerminal = new WeakMap<
  TerminalCursorSuppressionTarget,
  ReturnType<typeof setTimeout>
>()

function clearRestoreTimer(terminal: TerminalCursorSuppressionTarget): void {
  const timer = restoreTimerByTerminal.get(terminal)
  if (timer) {
    clearTimeout(timer)
    restoreTimerByTerminal.delete(terminal)
  }
}

export function restoreForegroundTerminalCursor(terminal: TerminalCursorSuppressionTarget): void {
  clearRestoreTimer(terminal)
  terminal.element?.classList?.remove(FOREGROUND_CURSOR_SUPPRESSED_CLASS)
}

export function scheduleForegroundTerminalCursorRestore(
  terminal: TerminalCursorSuppressionTarget,
  delayMs = FOREGROUND_CURSOR_RESTORE_DELAY_MS
): void {
  if (!terminal.element) {
    return
  }
  clearRestoreTimer(terminal)
  const timer = setTimeout(() => {
    restoreTimerByTerminal.delete(terminal)
    terminal.element?.classList?.remove(FOREGROUND_CURSOR_SUPPRESSED_CLASS)
  }, delayMs)
  restoreTimerByTerminal.set(terminal, timer)
}

export function suppressForegroundTerminalCursor(terminal: TerminalCursorSuppressionTarget): void {
  if (!terminal.element) {
    return
  }
  clearRestoreTimer(terminal)
  terminal.element.classList?.add(FOREGROUND_CURSOR_SUPPRESSED_CLASS)
}
