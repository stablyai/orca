import { translate } from '@/i18n/i18n'
import { stripIpcInvokeEnvelopeFrom } from '@/lib/ipc-error'
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

/**
 * Copy for a clipboard image that could not be staged for the terminal.
 *
 * The staging step is `clipboard:saveImageAsTempFile`, so a rejection arrives wrapped in Electron's
 * IPC envelope. This surface is the terminal error toast, which the pane also reaches through
 * `appendTerminalErrorMessage` — but this path calls `setTerminalError` directly, so the envelope
 * has to come off here as well. Nothing is discarded: the caller logs the rejection.
 */
export function formatClipboardImagePasteError(error: unknown): string {
  // Why the `From` form: a non-Error rejection still carries a reason worth showing, and a nullish
  // one carries none at all — absent and empty take the same branch, but neither prints the wrapper.
  const detail = stripIpcInvokeEnvelopeFrom(error)
  if (detail === null) {
    return translate(
      'auto.components.terminal.pane.terminalPasteErrors.imagePasteUnreadable',
      'Image paste failed, and the failure did not include a readable reason.'
    )
  }
  return translate(
    'auto.components.terminal.pane.terminalPasteErrors.imagePasteFailed',
    'Image paste failed: {{detail}}',
    { detail }
  )
}
