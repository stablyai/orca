// Tabs this desktop created (desktop-created-server-tabs) in a workspace their server's frames draw
// now: the server's groups have no place of their own for them. Kept out of the record so store
// slices can import the record without the frame runtime.

import { isFrameDrawnServerWorkspace } from '@/runtime/web-session-tabs-sync/frame-drawn-server-workspaces'
import { desktopCreatedServerTabEnvironments } from './desktop-created-server-tabs'

/** By tab-bar or entity id. Such a tab moves only within the server's groups: it never splits off. */
export function isDesktopCreatedTabInFrameDrawnServerWorkspace(
  workspace: string,
  id: string
): boolean {
  return desktopCreatedServerTabEnvironments(workspace, id).some((environmentId) =>
    isFrameDrawnServerWorkspace(environmentId, workspace)
  )
}

/** A group's tabs the server's group has too: all but this desktop's own. */
export function serverTabCount(workspace: string, tabOrder: readonly string[]): number {
  return tabOrder.filter((id) => !isDesktopCreatedTabInFrameDrawnServerWorkspace(workspace, id))
    .length
}
