import { translate } from '@/i18n/i18n'

// Why one value instead of the three booleans/strings this replaces (error, reconnectAvailable,
// busy): they always described a single thing — what this stream is doing right now — but were
// written independently from ~15 sites, so nothing stopped them disagreeing. Every defect three
// review rounds found in this area was one such disagreement:
//
//   stopped, but no affordance      -> the pane stranded (the bug this work exists to fix)
//   stopped, but no message         -> the control renders inside the message, so it could not render
//   retrying, but affordance shown  -> offered a manual retry ~500ms before the automatic one
//   stopped, but still busy         -> a spinner over a frozen frame, blocking the pane's own input
//
// Expressed as one tagged value, none of those four is a state you can write down. `busy`, the
// message, and whether the reconnect control appears are all derived from it, so they cannot drift.
export type RemoteBrowserStreamStatus =
  | { kind: 'idle' }
  /** Establishing a stream: no stream yet, and no failure to report. */
  | { kind: 'opening' }
  /** A confirmed-live stream; the host has sent 'ready'. */
  | { kind: 'live' }
  /** Automatic recovery is still running. The user is told, but not asked to act. */
  | { kind: 'retrying'; attempt: number; notice: string }
  /** Automatic recovery is over. This is the only state that offers a reconnect. */
  | { kind: 'stopped'; notice: string }

export const REMOTE_BROWSER_STREAM_IDLE: RemoteBrowserStreamStatus = { kind: 'idle' }
export const REMOTE_BROWSER_STREAM_OPENING: RemoteBrowserStreamStatus = { kind: 'opening' }
export const REMOTE_BROWSER_STREAM_LIVE: RemoteBrowserStreamStatus = { kind: 'live' }

export function remoteBrowserStreamRetrying(
  attempt: number,
  notice: string
): RemoteBrowserStreamStatus {
  return { kind: 'retrying', attempt, notice }
}

export function remoteBrowserStreamStopped(notice: string): RemoteBrowserStreamStatus {
  return { kind: 'stopped', notice }
}

/** Why the pane must not paint a stale frame as interactive: nothing is arriving in these states. */
export function isRemoteBrowserStreamBusy(status: RemoteBrowserStreamStatus): boolean {
  return status.kind === 'opening' || status.kind === 'retrying'
}

/** The stream's own message. Incidental notices (input failures, URL validation) are separate. */
export function remoteBrowserStreamNotice(status: RemoteBrowserStreamStatus): string | null {
  return status.kind === 'retrying' || status.kind === 'stopped' ? status.notice : null
}

// Why only 'stopped': while attempts remain, a manual control competes with the automatic recovery
// that is about to run anyway; and once live there is nothing to reconnect.
export function canReconnectRemoteBrowserStream(status: RemoteBrowserStreamStatus): boolean {
  return status.kind === 'stopped'
}

// Why the pane authors these rather than forwarding the failure's own message: those strings come
// from the transport layer and are written for logs (e.g. "Runtime environment is manually
// disconnected." — an RPC error with the code runtime_manually_disconnected). They name our
// internals rather than the user's situation and none of them change what the user can do, which
// the reconnect control already says. The raw error is still logged, so diagnosis keeps the detail
// the UI drops. A failure we classified ourselves keeps its own message: it is specific and true,
// and flattening "The selected runtime does not support remote browser streaming." into "lost
// connection" would be both vaguer and wrong.

/** The stream was established and then died. */
export function remoteBrowserStreamLostNotice(): string {
  return translate(
    'auto.components.BrowserPane.streamConnectionLost',
    'Lost connection to the remote server.'
  )
}

/** Nothing was ever established — saying "lost" would name something the user never had. */
export function remoteBrowserStreamUnreachableNotice(): string {
  return translate(
    'auto.components.BrowserPane.streamConnectionUnreachable',
    'Cannot reach the remote server.'
  )
}
