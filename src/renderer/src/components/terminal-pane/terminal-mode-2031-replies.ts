import { mode2031SequenceFor } from '../../../../shared/terminal-color-scheme-protocol'
import type { TerminalColorSchemeMode } from '../../../../shared/terminal-color-scheme-protocol'
import type { PtyTransport } from './pty-transport'

const MODE_2031_CONNECT_RETRY_MS = 25
const MODE_2031_CONNECT_ATTEMPTS = 8

type Mode2031ReplyTransport = Pick<PtyTransport, 'isConnected' | 'sendInputImmediate'>

type Mode2031SeedReplyDeps = {
  hasPane: (paneId: number) => boolean
  isSubscribed: (paneId: number) => boolean
  getTransport: (paneId: number) => Mode2031ReplyTransport | undefined
  getMode: () => TerminalColorSchemeMode | null
  recordMode: (paneId: number, mode: TerminalColorSchemeMode) => void
  schedule: (callback: () => void, delayMs: number) => void
}

function sendMode2031Reply(
  transport: Mode2031ReplyTransport,
  mode: TerminalColorSchemeMode
): boolean {
  // Why: fish stops reading mode-2031 replies quickly; remote input batching
  // can otherwise deliver this terminal response after the shell regains input.
  return transport.sendInputImmediate(mode2031SequenceFor(mode))
}

export function pushMode2031SeedReply(paneId: number, deps: Mode2031SeedReplyDeps): void {
  let attempts = 0
  const send = (): void => {
    // Why: a TUI can unsubscribe while the PTY is connecting; every delayed
    // attempt must revalidate intent or its color reply can land at a shell prompt.
    if (!deps.hasPane(paneId) || !deps.isSubscribed(paneId)) {
      return
    }
    const transport = deps.getTransport(paneId)
    if (!transport?.isConnected()) {
      attempts += 1
      if (attempts < MODE_2031_CONNECT_ATTEMPTS) {
        deps.schedule(send, MODE_2031_CONNECT_RETRY_MS)
      }
      return
    }
    const mode = deps.getMode()
    if (mode && sendMode2031Reply(transport, mode)) {
      deps.recordMode(paneId, mode)
    }
  }
  send()
}

// Appearance updates include font and opacity changes, so only report actual
// color-mode flips to programs that still have mode 2031 enabled.
export function maybePushMode2031Flip(
  paneId: number,
  mode: TerminalColorSchemeMode,
  transport: Mode2031ReplyTransport,
  paneMode2031: Map<number, boolean>,
  paneLastThemeMode: Map<number, TerminalColorSchemeMode>
): boolean {
  if (!transport.isConnected()) {
    return false
  }
  if (!paneMode2031.get(paneId)) {
    return false
  }
  if (paneLastThemeMode.get(paneId) === mode) {
    return false
  }
  if (!sendMode2031Reply(transport, mode)) {
    return false
  }
  paneLastThemeMode.set(paneId, mode)
  return true
}
