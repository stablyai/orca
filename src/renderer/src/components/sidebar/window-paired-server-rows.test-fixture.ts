import type { AppState } from '@/store'
import { getAllWorktreesFromState, getRepoMapFromState } from '@/store/selectors'
import { projectResolvedWorktreeLineage } from '../../../../shared/resolved-worktree-lineage'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import {
  pairedServerRowOfWorktree,
  type PairedServerHostFacts,
  type PairedServerWorkspaceRow
} from '../../../../shared/sidebar-list/paired-server-rows'
import { describePairedServerHosts } from '../../../../shared/paired-server-hosts'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'

/** The paired-server rows the window fetched itself, keyed by host-qualified id, for these hosts. */
export function readWindowPairedServerRows(
  state: Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces' | 'repos' | 'worktreeLineageById'>,
  hostIds: ReadonlySet<string>
): Map<string, PairedServerWorkspaceRow> {
  const rows = new Map<string, PairedServerWorkspaceRow>()
  const repoById = getRepoMapFromState(state)
  // The server sends only edges its own check keeps, so the window checks its copy the same way.
  const checkedLineageByKey = new Map<string, WorktreeLineage | null>()
  for (const hostId of hostIds) {
    const hostWorktrees = getAllWorktreesFromState(state).filter(
      (worktree) => worktree.hostId === hostId
    )
    for (const worktree of projectResolvedWorktreeLineage(
      hostWorktrees,
      state.worktreeLineageById
    )) {
      checkedLineageByKey.set(getWorktreeHostIdentity(worktree), worktree.lineage)
    }
  }
  const add = (worktree: Worktree, kind: PairedServerWorkspaceRow['kind']): void => {
    if (!worktree.hostId || !hostIds.has(worktree.hostId)) {
      return
    }
    const row = pairedServerRowOfWorktree(
      worktree,
      kind,
      repoById.get(worktree.repoId),
      checkedLineageByKey.get(getWorktreeHostIdentity(worktree))
    )
    rows.set(row.key, row)
  }
  for (const worktree of getAllWorktreesFromState(state)) {
    add(worktree, 'git')
  }
  for (const folder of state.folderWorkspaces ?? []) {
    add(folderWorkspaceToWorktree(folder), 'folder')
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
