import type { RemoteBrowserPageSessionDeps } from './remote-browser-page-session'
import type { RemoteBrowserScreencastSubscribe } from './remote-browser-screencast-subscription'
import type { RemoteBrowserStreamStatus } from './remote-browser-stream-status'
import type {
  RemoteBrowserPaneIdentity,
  RemoteBrowserStreamToken,
  RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'

export type RemoteBrowserStreamLifecycleDeps = Omit<RemoteBrowserPageSessionDeps, 'tokens'> & {
  identity: RemoteBrowserPaneIdentity
  subscribeScreencast: RemoteBrowserScreencastSubscribe
  waitForViewportSize: () => Promise<RemoteBrowserViewportSize | null>
  readViewportSize: () => RemoteBrowserViewportSize | null
  syncViewport: (pageId: string) => Promise<void>
  getDeviceScaleFactor: () => number
  // Publish one status so busy, notice and reconnect cannot disagree; only the lifecycle knows the remaining retry budget.
  setStatus: (status: RemoteBrowserStreamStatus) => void
  clearFrame: () => void
  handleFrameBytes: (token: RemoteBrowserStreamToken, bytes: Uint8Array<ArrayBufferLike>) => void
}
