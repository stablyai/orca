// Why: until a shell or agent first enables bracketed paste, a raw line break in a user's paste submits as Enter.
const STARTUP_PASTE_WINDOW_MS = 10_000
const ESCAPE = '\u001b'
const BRACKETED_PASTE_ENABLE_RE = /^\[\?(?:\d+;)*2004(?:;\d+)*h/
const ENABLE_SEQUENCE_SCAN_MAX = 64

type StartupPasteTerminal = { modes: { bracketedPasteMode: boolean } }

type StartupPasteState =
  | { bracketedPasteEnabled: true }
  | { bracketedPasteEnabled: false; firstOutputAtMs: number; escapeTail: string }

const startupPasteStateByTerminal = new WeakMap<StartupPasteTerminal, StartupPasteState>()

function enablesBracketedPaste(data: string): boolean {
  for (let index = data.indexOf(ESCAPE); index !== -1; index = data.indexOf(ESCAPE, index + 1)) {
    if (
      BRACKETED_PASTE_ENABLE_RE.test(data.slice(index + 1, index + 1 + ENABLE_SEQUENCE_SCAN_MAX))
    ) {
      return true
    }
  }
  return false
}

// Keeps an unfinished escape sequence so an enable split across output chunks is still seen.
function trailingEscapeTail(data: string): string {
  const index = data.lastIndexOf(ESCAPE)
  return index === -1 || data.length - index > ENABLE_SEQUENCE_SCAN_MAX ? '' : data.slice(index)
}

export function observeTerminalStartupPasteOutput(
  terminal: StartupPasteTerminal,
  data: string,
  nowMs: number = Date.now()
): void {
  const state = startupPasteStateByTerminal.get(terminal)
  if (state?.bracketedPasteEnabled) {
    return
  }
  const scanned = (state?.escapeTail ?? '') + data
  startupPasteStateByTerminal.set(
    terminal,
    enablesBracketedPaste(scanned)
      ? { bracketedPasteEnabled: true }
      : {
          bracketedPasteEnabled: false,
          firstOutputAtMs: state?.firstOutputAtMs ?? nowMs,
          escapeTail: trailingEscapeTail(scanned)
        }
  )
}

export function isTerminalStartingForPaste(
  terminal: StartupPasteTerminal,
  nowMs: number = Date.now()
): boolean {
  if (terminal.modes.bracketedPasteMode) {
    startupPasteStateByTerminal.set(terminal, { bracketedPasteEnabled: true })
    return false
  }
  const state = startupPasteStateByTerminal.get(terminal)
  if (!state) {
    // No output yet: the shell has not started reading, so the window starts at its first output.
    return true
  }
  return !state.bracketedPasteEnabled && nowMs - state.firstOutputAtMs < STARTUP_PASTE_WINDOW_MS
}
