// Project desktop-created tab exceptions into current server-frame groups; keep this outside the record so store slices need no frame-runtime imports.

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
