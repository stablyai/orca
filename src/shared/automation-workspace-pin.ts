/**
 * The SSH target a stored automation's workspace pins it to.
 *
 * A folder workspace can execute on an SSH host while the automation's project
 * is local, and the pin is where the run actually goes — so it, not the project,
 * decides that record's host. The list projection, the create/update capture and
 * the load-time backfill all have to agree on that answer, so it is resolved
 * here once rather than re-derived per caller.
 */

import type { Automation } from './automations-types'
import type { AutomationWorkspaceHost } from './automation-list-scope'
import {
  resolveFolderWorkspaceHost,
  type FolderWorkspaceHostState
} from './folder-workspace-execution-host'
import { parseWorkspaceKey } from './workspace-scope'

/** A pinned SSH target plus the generation its registration currently carries. */
export type AutomationWorkspaceSshPin = { targetId: string; generation: number | undefined }

export function resolveAutomationWorkspaceHost(
  state: FolderWorkspaceHostState,
  workspaceId: Automation['workspaceId']
): AutomationWorkspaceHost {
  const scope = parseWorkspaceKey(workspaceId ?? '')
  if (scope?.type !== 'folder') {
    return { kind: 'unpinned' }
  }
  const host = resolveFolderWorkspaceHost(state, scope.folderWorkspaceId)
  // A workspace that is gone proves nothing about the host, so the repo still decides.
  return host.kind === 'missing' ? { kind: 'unpinned' } : host
}

/** The pinned SSH target id, if the workspace names one. */
export function resolveAutomationWorkspaceSshTargetId(
  state: FolderWorkspaceHostState,
  workspaceId: Automation['workspaceId']
): string | undefined {
  const host = resolveAutomationWorkspaceHost(state, workspaceId)
  return host.kind === 'ssh' ? host.targetId : undefined
}
