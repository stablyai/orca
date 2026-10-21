// Whether a workspace's first surface is created. One answer for every sender, so a window and the
// runtime asking at once still make one tab.

import type { InitialSurfaceReason } from './workspace-layout-command-types'
import type { WorkspaceLayoutModel } from './workspace-layout-model'

/**
 * Only into a workspace with no tab of any kind. A relaunch also leaves alone a workspace whose
 * saved terminal row is empty: a close emptied it. An entry published for a workspace that never
 * had a terminal is not such a row.
 */
export function admitsInitialSurface(
  model: WorkspaceLayoutModel,
  workspaceKey: string,
  reason: InitialSurfaceReason
): boolean {
  if ((model.workspaces[workspaceKey]?.tabs.length ?? 0) > 0) {
    return false
  }
  return reason === 'activation' || !model.legacy.terminalRowOwners[workspaceKey]
}
