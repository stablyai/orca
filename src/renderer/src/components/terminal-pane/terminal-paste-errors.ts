import { toast } from 'sonner'
import type { TerminalPasteExecutionReason } from './terminal-paste-model'

/** Stable sonner id so repeated focus-churn cancels replace instead of stacking. */
export const TERMINAL_PASTE_CANCELLED_TOAST_ID = 'terminal-paste-cancelled'

const TRANSIENT_PASTE_CANCELLATION_REASONS: ReadonlySet<TerminalPasteExecutionReason> = new Set([
  'stale-target',
  'target-disconnected',
  'operation-timeout'
])

const PASTE_CANCELLED_PREFIX = 'Paste cancelled:'

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

/** Focus/disconnect/timeout cancels are expected races — one-shot notice, not a durable error. */
export function isTransientTerminalPasteCancellation(
  reason: TerminalPasteExecutionReason | undefined
): boolean {
  return reason != null && TRANSIENT_PASTE_CANCELLATION_REASONS.has(reason)
}

/**
 * Defense for cancel strings still parked on the durable error surface.
 * Fail-closed on aggregates: only pure cancel line sets are transient — one
 * durable line mixed in (via appendTerminalErrorMessage) must keep the banner.
 */
export function isTransientTerminalPasteCancellationMessage(message: string): boolean {
  const lines = message.split('\n').filter((line) => line.length > 0)
  return lines.length > 0 && lines.every((line) => line.startsWith(PASTE_CANCELLED_PREFIX))
}

/**
 * Surfaces paste outcome to the user: cancellations auto-dismiss via sonner;
 * real failures stay on the durable terminal error banner.
 */
export function reportTerminalPasteExecutionOutcome(
  reason: TerminalPasteExecutionReason | undefined,
  onPersistentError: (message: string) => void
): void {
  const message = formatTerminalPasteExecutionError(reason)
  if (isTransientTerminalPasteCancellation(reason)) {
    toast.message(message, {
      id: TERMINAL_PASTE_CANCELLED_TOAST_ID,
      duration: 4_000
    })
    return
  }
  onPersistentError(message)
}
