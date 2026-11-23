import { useState } from 'react'
import type { BrowserScreencastPointer } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import type { RemoteBrowserScreencastEvents } from './remote-browser-screencast-subscription'
import { createStreamedBrowserAgentCursor } from '../agent-cursor/browser-agent-activity-state'

/** What a streamed page's host reports beside frames: its cursor and an agent's pointer. */
export function useRemoteBrowserStreamViewerState(getBrowserPageId: () => string): {
  viewerEvents: Pick<RemoteBrowserScreencastEvents, 'onPointer' | 'onAgentCursor'>
  pagePointer: BrowserScreencastPointer | null
} {
  const [pagePointer, setPagePointer] = useState<BrowserScreencastPointer | null>(null)
  // The stream lifecycle is built once, so these callbacks must stay the first render's.
  const [viewerEvents] = useState(() => ({
    onPointer: setPagePointer,
    onAgentCursor: createStreamedBrowserAgentCursor(getBrowserPageId)
  }))
  return { viewerEvents, pagePointer }
}
