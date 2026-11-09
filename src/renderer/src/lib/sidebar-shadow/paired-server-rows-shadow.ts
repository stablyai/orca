import {
  selectWorktreesByRepo,
  selectFolderWorkspaces
} from '@/store/workspaces/catalog/workspace-record-fields'
import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { projectResolvedWorktreeLineage } from '../../../../shared/resolved-worktree-lineage'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import {
  pairedServerRowOfWorktree,
  type PairedServerHostFacts,
  type PairedServerWorkspaceRow
} from '../../../../shared/sidebar-list/paired-server-rows'
import { describePairedServerHosts } from '../../../../shared/remote-runtime/host-catalog/paired-server-hosts'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import { lineageStoreKeyOfRow } from '../../../../shared/worktree/cross-store-lineage-resolution'
import { validCrossStoreLineage } from '../../../../shared/worktree/cross-store-lineage-records'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { folderLineageEdgeOf } from '../../../../shared/worktree/folder-lineage-parents'

/** The paired-server rows the window fetched itself, keyed by host-qualified id, for these hosts. */
export function readWindowPairedServerRows(
  state: Pick<
    AppState,
    | 'worktreesByRepo'
    | 'folderWorkspaces'
    | 'repos'
    | 'worktreeLineageById'
    | 'crossStoreLineageByStoreKey'
    | 'workspaceLineageByChildKey'
  >,
  hostIds: ReadonlySet<string>
): Map<string, PairedServerWorkspaceRow> {
  const rows = new Map<string, PairedServerWorkspaceRow>()
  const repoById = getIndexedRepoMap(state.repos)
  // The server sends only edges its own check keeps, so the window checks its copy the same way.
  const checkedLineageByKey = new Map<string, WorktreeLineage | null>()
  for (const hostId of hostIds) {
    const hostWorktrees = getIndexedAllWorktrees(selectWorktreesByRepo(state)).filter(
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
    const storeKey = lineageStoreKeyOfRow(worktree)
    const row = pairedServerRowOfWorktree(
      worktree,
      kind,
      repoById.get(worktree.repoId),
      checkedLineageByKey.get(getWorktreeHostIdentity(worktree)),
      storeKey === undefined
        ? undefined
        : validCrossStoreLineage(state.crossStoreLineageByStoreKey[storeKey])[
            worktreeWorkspaceKey(worktree.id)
          ],
      kind === 'git'
        ? folderLineageEdgeOf(
            state.workspaceLineageByChildKey[worktreeWorkspaceKey(worktree.id)],
            worktree.instanceId
          )
        : undefined
    )
    rows.set(row.key, row)
  }
  for (const worktree of getIndexedAllWorktrees(selectWorktreesByRepo(state))) {
    add(worktree, 'git')
  }
  for (const folder of selectFolderWorkspaces(state) ?? []) {
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
    hosts.flatMap(({ hostId, label, health, compatibility, pairedDeviceId, installationId }) =>
      hostIds.has(hostId)
        ? [
            [
              hostId,
              {
                label,
                health,
                compatibility,
                pairedDeviceId,
                ...(installationId ? { installationId } : {})
              }
            ] as const
          ]
        : []
    )
  )
}
