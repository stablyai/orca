// Why: until a shell or agent first enables bracketed paste, a raw line break in a user's paste submits as Enter.
const STARTUP_PASTE_WINDOW_MS = 10_000
const ESCAPE = '\u001b'
const BRACKETED_PASTE_ENABLE_RE = /^\[\?(?:\d+;)*2004(?:;\d+)*h/

type StartupPasteTerminal = { modes: { bracketedPasteMode: boolean } }

type StartupPasteState = { firstSeenAtMs: number; bracketedPasteEnabled: boolean }

function enablesBracketedPaste(data: string): boolean {
  for (let index = data.indexOf(ESCAPE); index !== -1; index = data.indexOf(ESCAPE, index + 1)) {
    if (BRACKETED_PASTE_ENABLE_RE.test(data.slice(index + 1, index + 65))) {
      return true
    }
  }
  return false
}

const startupPasteStateByTerminal = new WeakMap<StartupPasteTerminal, StartupPasteState>()

export function observeTerminalStartupPasteOutput(
  terminal: StartupPasteTerminal,
  data: string,
  nowMs: number = Date.now()
): void {
  const state = startupPasteStateByTerminal.get(terminal)
  if (state?.bracketedPasteEnabled) {
    return
  }
  startupPasteStateByTerminal.set(terminal, {
    firstSeenAtMs: state?.firstSeenAtMs ?? nowMs,
    bracketedPasteEnabled: enablesBracketedPaste(data)
  })
}

export function isTerminalStartingForPaste(
  terminal: StartupPasteTerminal,
  nowMs: number = Date.now()
): boolean {
  if (terminal.modes.bracketedPasteMode) {
    return false
  }
  const state = startupPasteStateByTerminal.get(terminal)
  if (!state) {
    startupPasteStateByTerminal.set(terminal, {
      firstSeenAtMs: nowMs,
      bracketedPasteEnabled: false
    })
    return true
  }
  return !state.bracketedPasteEnabled && nowMs - state.firstSeenAtMs < STARTUP_PASTE_WINDOW_MS
}
