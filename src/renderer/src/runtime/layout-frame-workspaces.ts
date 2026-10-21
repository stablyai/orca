// Main's latest frame copy of a workspace, for readers outside the frame sync (a reopen checking
// whether main already holds what it would send). Its own module so they do not pull the sync in.

import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'

type WorkspaceReader = (worktreeId: string) => PublishedWorkspaceLayout | undefined

let reader: WorkspaceReader | null = null

/** Set by the window's layout stream when it starts; the returned stop clears it if still current. */
export function provideLayoutFrameWorkspaces(next: WorkspaceReader): () => void {
  reader = next
  return () => {
    if (reader === next) {
      reader = null
    }
  }
}

/** Main's workspace in the latest frames; undefined before a stream starts or once it closed. */
export function layoutFrameWorkspace(worktreeId: string): PublishedWorkspaceLayout | undefined {
  return reader?.(worktreeId)
}
