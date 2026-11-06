import type { TerminalPasteExecutionReason } from './terminal-paste-model'

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
