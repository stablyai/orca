// Share initial-surface admission so concurrent window/runtime requests create one tab.

import type { LayoutClientVisibility } from './workspace-layout-client-visibility'
import type { InitialSurfaceReason } from './workspace-layout-command-types'
import type { WorkspaceLayoutModel } from './workspace-layout-model'

/** Require no client-visible tabs. On relaunch, a saved empty terminal row means closed; an entry for a workspace that never had terminals does not. */
export function admitsInitialSurface(
  model: WorkspaceLayoutModel,
  workspaceKey: string,
  reason: InitialSurfaceReason,
  visible?: LayoutClientVisibility
): boolean {
  if (model.workspaces[workspaceKey]?.tabs.some((tab) => !visible || visible(tab))) {
    return false
  }
  return reason === 'activation' || !model.legacy.terminalRowOwners[workspaceKey]
}
