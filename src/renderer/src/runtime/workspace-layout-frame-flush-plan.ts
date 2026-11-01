import type { AppState } from '@/store/types'
import type { WorkspaceLayoutCache } from '@/store/workspace-layout-cache'
import type { TerminalTabTitleUpdate } from '@/store/slices/terminal-tab-title-batch'
import type { PendingWorkspaceChanges } from './workspace-layout-frame-pending'
import type { LayoutFrameSource } from './layout-frame-stream'
import { liveTitleUpdates } from './workspace-layout-frame-changes'

/** Classify and take accumulated frame work before the ordinary store writer builds it. */
export function planLayoutFrameFlush(
  state: AppState,
  cache: WorkspaceLayoutCache,
  pending: Map<string, PendingWorkspaceChanges>,
  shown: Set<string>,
  source: LayoutFrameSource
) {
  const drawn = source.draws(state)
  const changed: string[] = []
  const fullBuilt: string[] = []
  const workspaceBuilt: string[] = []
  const rebound = new Map<string, ReadonlySet<string>>()
  const titleUpdates: TerminalTabTitleUpdate[] = []
  for (const [key, layout] of Object.entries(cache)) {
    const changes = pending.get(key)
    if (!drawn(key)) {
      // Frames the window did not draw: its next draw takes the full build.
      if (changes) {
        shown.delete(key)
      }
      continue
    }
    if (shown.has(key) && !changes) {
      continue
    }
    changed.push(key)
    if (!shown.has(key)) {
      fullBuilt.push(key)
    } else if (changes?.rebuild) {
      workspaceBuilt.push(key)
    } else if (changes) {
      titleUpdates.push(
        ...liveTitleUpdates(
          changes.titled,
          layout,
          (tabId) => state.terminalLayoutsByTabId[tabId]?.activeLeafId
        )
      )
      if (changes.rebound.size > 0) {
        rebound.set(key, changes.rebound)
      }
    }
  }
  pending.clear()
  // A workspace main stopped publishing keeps what the window shows; main has nothing to say.
  for (const key of shown) {
    if (!(key in cache)) {
      shown.delete(key)
    }
  }
  return { changed, fullBuilt, workspaceBuilt, rebound, titleUpdates }
}
