import { getShortcutPlatform } from '@/lib/shortcut-platform'
import type { DeferredTerminalPasteDropCause } from './terminal-deferred-paste'
import type { TerminalPasteExecutionReason } from './terminal-paste-model'

export const TERMINAL_CLIPBOARD_READ_UNAVAILABLE_MESSAGE =
  'Paste failed: could not read the clipboard. Copy again, then retry.'

export function formatTerminalPasteExecutionError(
  reason: TerminalPasteExecutionReason | undefined
): string {
  if (reason === 'payload-too-large') {
    return 'Paste failed: clipboard text is too large for a safe terminal paste.'
  }
  if (reason === 'stale-target') {
    return 'Paste cancelled: terminal focus changed before paste started.'
  }
  if (reason === 'target-disconnected') {
    return 'Paste cancelled: terminal disconnected before paste completed.'
  }
  if (reason === 'pty-writer-unavailable') {
    return 'Paste failed: terminal is not ready for large paste.'
  }
  if (reason === 'operation-timeout') {
    return 'Paste cancelled: terminal did not accept paste before the safety timeout.'
  }
  return 'Paste failed.'
}

/** The payload is gone by the time this shows, so the copy has to tell the user
 *  what to do next rather than only what went wrong — and name the cause it
 *  actually hit, because "did not return in time" is untrue for a pane the user
 *  closed or a sibling they clicked into. */
export function formatDeferredTerminalPasteDroppedError(
  cause: DeferredTerminalPasteDropCause = 'deadline-passed',
  platform: NodeJS.Platform = getShortcutPlatform()
): string {
  const shortcut = platform === 'darwin' ? '⌘V' : 'Ctrl+V'
  const retry = `Click the terminal and press ${shortcut} to paste again.`
  if (cause === 'target-pane-closed') {
    return `Paste cancelled: the terminal it was meant for was closed. ${retry}`
  }
  if (cause === 'focus-moved-to-other-pane') {
    return `Paste cancelled: focus moved to a different terminal. ${retry}`
  }
  return `Paste cancelled: terminal focus did not return in time. ${retry}`
}
