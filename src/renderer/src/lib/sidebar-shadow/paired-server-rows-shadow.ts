import type { AppState } from '@/store'
import { getAllWorktreesFromState, getRepoMapFromState } from '@/store/selectors'
import {
  projectResolvedWorktreeLineage,
  worktreeLineageFromWorkspaceLineage
} from '../../../../shared/resolved-worktree-lineage'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import {
  pairedServerRowOfWorktree,
  type PairedServerHostFacts,
  type PairedServerWorkspaceRow
} from '../../../../shared/sidebar-list/paired-server-rows'
import { describePairedServerHosts } from '../../../../shared/paired-server-hosts'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import type { Worktree } from '../../../../shared/worktree/types'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

/** The paired-server rows the window fetched itself, keyed by host-qualified id, for these hosts. */
export function readWindowPairedServerRows(
  state: Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces' | 'repos' | 'worktreeLineageById'> &
    Partial<Pick<AppState, 'workspaceLineageByChildKey'>>,
  hostIds: ReadonlySet<string>
): Map<string, PairedServerWorkspaceRow> {
  const rows = new Map<string, PairedServerWorkspaceRow>()
  const repoById = getRepoMapFromState(state)
  const add = (worktree: Worktree, kind: PairedServerWorkspaceRow['kind']): void => {
    if (!worktree.hostId || !hostIds.has(worktree.hostId)) {
      return
    }
    const row = pairedServerRowOfWorktree(
      worktree,
      kind,
      repoById.get(worktree.repoId),
      worktree.lineage
    )
    rows.set(row.key, row)
  }
  const folders = (selectFolderWorkspaces(state) ?? []).map((folder) => {
    const row = folderWorkspaceToWorktree(folder)
    const edge = state.workspaceLineageByChildKey?.[row.id]
    return { ...row, savedLineage: edge ? worktreeLineageFromWorkspaceLineage(edge) : null }
  })
  for (const worktree of projectResolvedWorktreeLineage(
    [...getAllWorktreesFromState(state), ...folders],
    state.worktreeLineageById
  )) {
    add(worktree, worktree.id.startsWith('folder:') ? 'folder' : 'git')
  }
  return rows
}

/** The window's header facts for these servers, from its own status, environment and label state. */
export function readWindowPairedServerHosts(
  state: Pick<
    AppState,
    | 'runtimeEnvironments'
    | 'runtimeStatusByEnvironmentId'
    | 'sshTargetLabels'
    | 'sshConnectionStates'
    | 'settings'
  >,
  hostIds: ReadonlySet<string>
): Map<string, PairedServerHostFacts> {
  const hosts = describePairedServerHosts({
    environments: state.runtimeEnvironments,
    statusByEnvironmentId: state.runtimeStatusByEnvironmentId,
    sshTargetLabels: state.sshTargetLabels,
    sshConnectionStates: state.sshConnectionStates,
    hostLabelOverrides: getHostDisplayLabelOverrides(state.settings)
  })
  return new Map(
    hosts.flatMap(({ hostId, label, health, compatibility, pairedDeviceId }) =>
      hostIds.has(hostId)
        ? [[hostId, { label, health, compatibility, pairedDeviceId }] as const]
        : []
    )
  )
}
