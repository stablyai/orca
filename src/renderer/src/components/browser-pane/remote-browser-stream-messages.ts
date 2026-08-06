import { translate } from '@/i18n/i18n'

// Why the pane authors these instead of forwarding the failure's own message: those strings come
// from the transport layer and are written for logs (e.g. "Runtime environment is manually
// disconnected." — an RPC error with the code runtime_manually_disconnected). They name our
// internals rather than the user's situation, raise a question nobody asked, and none of them
// change what the user can do about it, which the Reconnect control already says. The raw error is
// still logged, so diagnosis keeps the detail the UI drops.

/** The stream was established and then died. */
export const REMOTE_BROWSER_STREAM_LOST_MESSAGE = (): string =>
  translate(
    'auto.components.BrowserPane.streamConnectionLost',
    'Lost connection to the remote server.'
  )

/** Nothing was ever established — saying "lost" would name something the user never had. */
export const REMOTE_BROWSER_STREAM_UNREACHABLE_MESSAGE = (): string =>
  translate(
    'auto.components.BrowserPane.streamConnectionUnreachable',
    'Cannot reach the remote server.'
  )

type RemoteBrowserStreamStopSurface = {
  setError: (message: string | null) => void
  setBusy: (busy: boolean) => void
  setReconnectAvailable: (available: boolean) => void
}

// Why one helper for every stop: "the pane is no longer trying" is a single user-visible state, and
// it needs all three of these together. Reporting the message without the affordance strands the
// user; setting the affordance without a message makes it unrenderable, since the control lives
// inside the error toast; leaving busy on spins a dead pane and blocks its input handlers. Each of
// those was a real defect found in review, from a site that did two of the three.
export function announceRemoteBrowserStreamStopped(
  surface: RemoteBrowserStreamStopSurface,
  message: string
): void {
  surface.setError(message)
  surface.setReconnectAvailable(true)
  surface.setBusy(false)
}
