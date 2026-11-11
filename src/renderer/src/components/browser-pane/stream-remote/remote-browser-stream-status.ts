import { translate } from '@/i18n/i18n'

// Why one tagged value: busy, message and reconnect availability are derived from it, so they cannot disagree.
export type RemoteBrowserStreamStatus =
  | { kind: 'idle' }
  /** Establishing a stream: no stream yet, and no failure to report. */
  | { kind: 'opening' }
  /** A confirmed-live stream; the host has sent 'ready'. */
  | { kind: 'live' }
  // notice stays null until an attempt fails, so a blip absorbed by the budget stays invisible.
  | { kind: 'retrying'; notice: string | null }
  /** Automatic recovery is over. This is the only state that offers a reconnect. */
  | { kind: 'stopped'; notice: string }

export const REMOTE_BROWSER_STREAM_IDLE: RemoteBrowserStreamStatus = { kind: 'idle' }
export const REMOTE_BROWSER_STREAM_OPENING: RemoteBrowserStreamStatus = { kind: 'opening' }
export const REMOTE_BROWSER_STREAM_LIVE: RemoteBrowserStreamStatus = { kind: 'live' }

export function remoteBrowserStreamRetrying(notice: string | null): RemoteBrowserStreamStatus {
  return { kind: 'retrying', notice }
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
  return status.kind === 'stopped' || status.kind === 'retrying' ? status.notice : null
}

// Why only 'stopped': while attempts remain, a manual control competes with the automatic recovery
// that is about to run anyway; and once live there is nothing to reconnect.
export function canReconnectRemoteBrowserStream(status: RemoteBrowserStreamStatus): boolean {
  return status.kind === 'stopped'
}

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

export function remoteBrowserServiceUnavailableNotice(): string {
  return translate(
    'auto.components.BrowserPane.streamBrowserUnavailable',
    'The remote browser is unavailable. Check its setup on the server.'
  )
}

export function remoteBrowserStreamRestartFailedNotice(): string {
  return translate(
    'auto.components.BrowserPane.streamRestartFailed',
    'Failed to restart remote browser stream.'
  )
}

export function remoteBrowserStreamUnsupportedNotice(): string {
  return translate(
    'auto.components.BrowserPane.streamCapabilityUnsupported',
    'The selected runtime does not support remote browser streaming.'
  )
}
