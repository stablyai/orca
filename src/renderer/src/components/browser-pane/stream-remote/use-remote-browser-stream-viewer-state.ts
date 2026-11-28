import { useState } from 'react'
import type {
  BrowserScreencastDriverResult,
  BrowserScreencastPointer
} from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import type { RemoteBrowserScreencastEvents } from './remote-browser-screencast-subscription'
import { createStreamedBrowserAgentCursor } from '../agent-cursor/browser-agent-activity-state'

export type RemoteBrowserPageDriver = Omit<BrowserScreencastDriverResult, 'type'>

/** What a streamed page's host reports beside frames: its cursor, an agent's pointer and who drives it. */
export function useRemoteBrowserStreamViewerState(getBrowserPageId: () => string): {
  viewerEvents: Pick<RemoteBrowserScreencastEvents, 'onPointer' | 'onAgentCursor' | 'onDriver'>
  pagePointer: BrowserScreencastPointer | null
  pageDriver: RemoteBrowserPageDriver | null
} {
  const [pagePointer, setPagePointer] = useState<BrowserScreencastPointer | null>(null)
  const [pageDriver, setPageDriver] = useState<RemoteBrowserPageDriver | null>(null)
  // The stream lifecycle is built once, so these callbacks must stay the first render's.
  const [viewerEvents] = useState(() => ({
    onPointer: setPagePointer,
    onAgentCursor: createStreamedBrowserAgentCursor(getBrowserPageId),
    onDriver: setPageDriver
  }))
  return { viewerEvents, pagePointer, pageDriver }
}
