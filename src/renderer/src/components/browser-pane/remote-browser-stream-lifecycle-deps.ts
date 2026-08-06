import type { RemoteBrowserPageSessionDeps } from './remote-browser-page-session'
import type { RemoteBrowserScreencastSubscribe } from './remote-browser-screencast-subscription'
import type {
  RemoteBrowserPaneIdentity,
  RemoteBrowserStreamToken,
  RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'

// Everything RemoteBrowserStreamLifecycle needs from the React pane, kept separate so the pane can
// be read against one surface and the lifecycle can be driven from tests without one.
export type RemoteBrowserStreamLifecycleDeps = Omit<RemoteBrowserPageSessionDeps, 'tokens'> & {
  identity: RemoteBrowserPaneIdentity
  subscribeScreencast: RemoteBrowserScreencastSubscribe
  waitForViewportSize: () => Promise<RemoteBrowserViewportSize | null>
  readViewportSize: () => RemoteBrowserViewportSize | null
  syncViewport: (pageId: string) => Promise<void>
  getDeviceScaleFactor: () => number
  setBusy: (busy: boolean) => void
  setError: (message: string | null) => void
  // Why the lifecycle owns this rather than the pane inferring it: only this class knows whether a
  // failure still has retry budget left. The pane cannot tell "retrying" from "given up" from an
  // error message alone, and showing a reconnect control mid-retry invites fighting the loop.
  setReconnectAvailable: (available: boolean) => void
  clearFrame: () => void
  handleFrameBytes: (token: RemoteBrowserStreamToken, bytes: Uint8Array<ArrayBufferLike>) => void
}
