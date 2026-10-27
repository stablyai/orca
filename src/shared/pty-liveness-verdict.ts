/** Only owning-host evidence proves exit. Lost relay/contact or incomplete provider inventory is unverifiable,
 * never proof of death or a successful stop. */
export type PtyLivenessVerdict =
  | { status: 'exited' }
  | { status: 'live'; ptyIds: string[] }
  | { status: 'unverifiable'; reason: string }

export const SSH_PROVIDER_UNREGISTERED_REASON = 'its SSH provider is no longer registered'
export const NO_OBSERVING_PROVIDER_REASON = 'no registered provider can observe its host'
export const SSH_EXIT_UNCONFIRMED_REASON = 'the owning SSH host did not confirm the PTY exit'
export const PTY_LIVE_NOTE = 'The PTY is live.'

// Receipts/relayed errors may already end sentences; avoid duplicate punctuation.
function endSentence(detail: string): string {
  return /[.!?]$/u.test(detail.trimEnd()) ? detail.trimEnd() : `${detail.trimEnd()}.`
}

/** The one sentence every surface uses to admit a stop was not confirmed. */
export function describeUnconfirmedStop(reason: string): string {
  return `The PTY was not confirmed stopped: ${endSentence(reason)}`
}

/** A close's unconfirmed-stop sentence; it promises a retry only when the host recorded one. */
export function describeUnconfirmedCloseStop(close: {
  ptyStopReason?: string
  pendingKillRecorded?: true
}): string {
  const sentence = describeUnconfirmedStop(close.ptyStopReason ?? 'its host could not be reached')
  return close.pendingKillRecorded === true
    ? `${sentence} The kill retries when the host reconnects.`
    : sentence
}

/** Words a close whose PTY teardown was never confirmed, for a stop receipt. */
export function describeUnconfirmedAgentStop(close: {
  ptyStopVerdict?: 'live' | 'unverifiable'
  ptyStopReason?: string
}): string {
  const detail =
    close.ptyStopVerdict === 'live'
      ? 'it is live'
      : (close.ptyStopReason ?? 'the stop outcome could not be verified')
  return `The agent terminal was closed but its process could not be confirmed stopped: ${endSentence(detail)}`
}
