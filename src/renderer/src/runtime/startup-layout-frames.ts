import { useAppStore } from '@/store'
import { provideLayoutFrameTerminalPanes } from './layout-frame-terminal-panes'
import {
  openWorkspaceLayoutFrameSync,
  type WorkspaceLayoutFrameSync
} from './workspace-layout-frame-sync'

let startupFrames: WorkspaceLayoutFrameSync | null = null

/** After restore: the window's one layout stream shows the frames' workspaces from now on. */
export function showStartupLayoutFrames(): void {
  // Kept for the document's life: a local stream ends only with main, and a re-run boot reuses it.
  if (!startupFrames) {
    startupFrames = openWorkspaceLayoutFrameSync(useAppStore)
    provideLayoutFrameTerminalPanes(startupFrames)
  }
  startupFrames.start()
}
