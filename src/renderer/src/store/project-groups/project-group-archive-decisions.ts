import type { AppState } from '../types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { projectGroupHookOwner } from '../../../../shared/workspace-hook-owner'
import type { ProjectGroupArchiveDecisions } from '../../../../shared/project-group-removal'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { checkRuntimeGroupHooks } from '@/runtime/repo-hooks/runtime-hooks-client'
import { confirmInspectedArchiveHook } from '@/runtime/repo-hooks/ensure-hooks-confirmed'
import { resolveHookCommandSourcePolicy } from '../../../../shared/hook-command-source-policy'
import { getFolderWorkspaceHostId } from '../../../../shared/folder-workspaces/folder-workspace-host-id'

export async function collectProjectGroupArchiveDecisions(
  get: () => AppState,
  groupId: string,
  hostId: ExecutionHostId,
  workspaces: readonly FolderWorkspace[]
): Promise<{ archiveDecisions: ProjectGroupArchiveDecisions; workspaceCount: number }> {
  const groups = get().projectGroups.filter((group) => getRepoExecutionHostId(group) === hostId)
  const subtree = getProjectGroupSubtreeIds(groups, groupId)
  const selected = workspaces.filter(
    (workspace) =>
      subtree.has(workspace.projectGroupId) &&
      getFolderWorkspaceHostId(workspace, groups) === hostId
  )
  const ownersWithWorkspaces = new Set(selected.map((workspace) => workspace.projectGroupId))
  const archiveDecisions: ProjectGroupArchiveDecisions = {}
  for (const group of groups) {
    if (!ownersWithWorkspaces.has(group.id)) {
      continue
    }
    const owner = projectGroupHookOwner(group)
    if (!owner) {
      continue
    }
    try {
      const checked = await checkRuntimeGroupHooks(hostId, group.id, { background: true })
      if (
        checked.unavailable ||
        checked.status === 'error' ||
        (checked.hasHooks && !checked.hooks)
      ) {
        archiveDecisions[group.id] = { decision: 'skip' }
        continue
      }
      const policy = resolveHookCommandSourcePolicy(checked.hookSettings?.commandSourcePolicy, {
        hasLocalScript: Boolean(checked.hookSettings?.scripts.archive?.trim())
      })
      const shared = policy === 'local-only' ? '' : (checked.hooks?.scripts.archive?.trim() ?? '')
      archiveDecisions[group.id] = shared
        ? await confirmInspectedArchiveHook(get, owner.id, hostId, shared)
        : { decision: 'run' }
    } catch {
      archiveDecisions[group.id] = { decision: 'skip' }
    }
  }
  return { archiveDecisions, workspaceCount: selected.length }
}
