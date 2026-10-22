// The layout stream a frame sync reads: this window's own main's, or a paired server's under this
// window's ids. Only the local stream's positions answer this window's layout.apply replies.

import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import {
  beginLayoutFramePositions,
  endLayoutFramePositions,
  noteLayoutFramePosition
} from './layout-frame-position'
import { subscribeRuntimeLayout, type RuntimeLayoutStreamStatus } from './runtime-layout-client'
import { framesDrawWorkspace } from './workspace-layout-frame-drawn-workspaces'

/** Whose layout stream a sync shows, and which of the window's workspaces it draws. */
export type LayoutFrameSource = {
  target: RuntimeClientTarget
  draws: (state: AppState) => (key: string) => boolean
  /** Frames under this window's ids; the local stream's already are. */
  translate?: (frame: WorkspaceLayoutChangeFrame) => WorkspaceLayoutChangeFrame
  onStatus?: (status: RuntimeLayoutStreamStatus) => void
}

export const LOCAL_LAYOUT_FRAMES: LayoutFrameSource = {
  target: { kind: 'local' },
  draws: framesDrawWorkspace
}

/** `onOpen(false)` once no frame will come, `onOpen(true)` when a lost stream reopens. */
export function openLayoutFrameStream(
  source: LayoutFrameSource,
  receive: (frame: WorkspaceLayoutChangeFrame) => void,
  onOpen: (open: boolean) => void
): { close: () => void } {
  const local = source.target.kind === 'local'
  let open = true
  if (local) {
    beginLayoutFramePositions()
  }
  return subscribeRuntimeLayout(
    source.target,
    {},
    (frame) => receive(source.translate ? source.translate(frame) : frame),
    (status) => {
      if (status.state === 'lost' || status.state === 'refused') {
        console.warn('[layout-owner] layout stream stopped:', status)
      }
      if (status.state === 'connecting' && !open) {
        // The stream reopens after a loss; replies wait for its frames again.
        open = true
        if (local) {
          beginLayoutFramePositions()
        }
        onOpen(true)
      } else if (status.state !== 'connecting' && status.state !== 'live') {
        open = false
        if (local) {
          endLayoutFramePositions()
        }
        onOpen(false)
      }
      source.onStatus?.(status)
    },
    // After the frame's flush. A held tab may still show as the window drew it, so a waiting reply
    // checks the store rather than assume the frame shows.
    (seq) => queueMicrotask(() => local && open && noteLayoutFramePosition(seq))
  )
}
