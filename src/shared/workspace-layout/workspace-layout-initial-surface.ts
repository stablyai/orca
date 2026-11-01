// Share initial-surface admission so concurrent window/runtime requests create one tab.

import type { InitialSurfaceReason } from './workspace-layout-command-types'
import type { WorkspaceLayoutModel } from './workspace-layout-model'

/** Require no tabs of any kind. On relaunch, a saved empty terminal row means closed; an entry for a workspace that never had terminals does not. */
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
