import { stripErrorClassPrefix, stripIpcInvokeEnvelopeFrom } from '@/lib/ipc-error'

/**
 * User-facing copy for a provider sign-in failure.
 *
 * Sign-in crosses Electron IPC, so a rejection arrives wrapped in Electron's envelope. That
 * wrapper is transport, not a reason, and is removed by the canonical stripper before any of
 * the wording below is matched. Nothing is discarded: the caller still surfaces the message,
 * and Electron logs the handler's original error with its stack in the main process.
 */
export function getCodexAccountErrorDescription(error: unknown): string {
  // Why: a bare `Error: ` prefix is not the IPC envelope — it survives a main-side error whose
  // own message starts that way — so it is trimmed separately from the transport wrapper.
  const message = stripErrorClassPrefix(stripIpcInvokeEnvelopeFrom(error) ?? '').trim()
  const normalizedMessage = message.toLowerCase()

  // Why: Codex account actions cross the Electron IPC boundary, and invoke()
  // failures often include transport-level wrapper text that is useful in
  // devtools but noisy in product UI. Normalize the handful of expected auth
  // failures here so users see actionable sign-in guidance instead of IPC
  // internals or raw upstream wording.
  if (normalizedMessage.includes('timed out waiting for codex login to finish')) {
    return 'Codex sign-in took too long to finish. Please try again.'
  }
  if (normalizedMessage.includes('codex sign-in took too long to finish')) {
    return 'Codex sign-in took too long to finish. Please try again.'
  }
  if (
    normalizedMessage.includes('auth error 502') ||
    normalizedMessage.includes('gateway') ||
    normalizedMessage.includes('bad gateway')
  ) {
    return 'Codex sign-in is temporarily unavailable. Please try again in a minute.'
  }
  if (normalizedMessage.startsWith('codex login failed:')) {
    const loginMessage = message.slice('Codex login failed:'.length).trim()
    return loginMessage || 'Codex sign-in failed. Please try again.'
  }

  return message || 'Codex sign-in failed. Please try again.'
}

export function getClaudeAccountErrorDescription(error: unknown): string {
  return (
    stripErrorClassPrefix(stripIpcInvokeEnvelopeFrom(error) ?? '').trim() ||
    'Claude sign-in failed. Please try again.'
  )
}

export function isClaudeAccountCancellation(error: unknown): boolean {
  return getClaudeAccountErrorDescription(error).toLowerCase() === 'claude sign-in was cancelled.'
}
