import type { RemoteBrowserPageSessionDeps } from './remote-browser-page-session'
import type { RemoteBrowserScreencastSubscribe } from './remote-browser-screencast-subscription'
import type { RemoteBrowserStreamStatus } from './remote-browser-stream-status'
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
  // Why one setter instead of separate busy/error/reconnect calls: those three always described a
  // single thing — what this stream is doing — and writing them independently is what let them
  // disagree. Only this class knows whether a failure still has retry budget left, so it publishes
  // the state and the pane derives every visual from it. See remote-browser-stream-status.ts.
  setStatus: (status: RemoteBrowserStreamStatus) => void
  clearFrame: () => void
  handleFrameBytes: (token: RemoteBrowserStreamToken, bytes: Uint8Array<ArrayBufferLike>) => void
}
