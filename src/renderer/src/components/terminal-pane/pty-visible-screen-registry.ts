// Why a registry: renderer library code (the agent paste lane) has a ptyId and needs the text
// currently on that pane's screen, but the app store holds ids only — the live xterm.js
// Terminal exists solely inside the mounted pane. A pane publishes its terminal here for the
// lifetime of its PTY binding, exactly alongside its buffer serializer.

import {
  buildTerminalVisibleScreenText,
  type TerminalVisibleScreenSource
} from '../../../../shared/terminal-visible-screen-projection'

// Why ownership tokens: StrictMode mounts panes twice and same-PTY remounts can register the
// new terminal before the stale mount unregisters. Mirrors pty-buffer-serializer.ts.
type ScreenEntry = {
  terminal: TerminalVisibleScreenSource
  owner: symbol
}

const screensByPtyId = new Map<string, ScreenEntry>()

export function registerPtyVisibleScreen(
  ptyId: string,
  terminal: TerminalVisibleScreenSource
): () => void {
  const owner = Symbol(ptyId)
  screensByPtyId.set(ptyId, { terminal, owner })
  return () => {
    if (screensByPtyId.get(ptyId)?.owner === owner) {
      screensByPtyId.delete(ptyId)
    }
  }
}

/**
 * The visible screen of `ptyId`'s pane, in the same shape the main process hands its
 * wait-blocked detectors, or null when no pane currently owns this PTY.
 *
 * Null means "no evidence", not "nothing on screen": callers must not read it as a clean
 * screen.
 */
export function readPtyVisibleScreenText(ptyId: string): string | null {
  const entry = screensByPtyId.get(ptyId)
  if (!entry) {
    return null
  }
  try {
    return buildTerminalVisibleScreenText(entry.terminal)
  } catch {
    // A pane torn down between lookup and read has no screen to report.
    return null
  }
}
