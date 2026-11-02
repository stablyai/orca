import { useAppStore, type AppState } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import {
  folderWorkspaceRepoId,
  folderWorkspaceToWorktree
} from '../../../../shared/folder-workspace-worktree'
import {
  PairedServerRowsSnapshotSchema,
  type PairedServerHostFacts,
  type PairedServerWorkspaceRow
} from '../../../../shared/sidebar-list/paired-server-rows'
import { describePairedServerHosts } from '../../../../shared/paired-server-hosts'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import { defineSidebarShadowDomain, type SidebarShadowMainRead } from './sidebar-shadow-comparison'

/** The paired-server rows the window fetched itself, keyed by host-qualified id, for these hosts. */
export function readWindowPairedServerRows(
  state: Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces'>,
  hostIds: ReadonlySet<string>
): Map<string, PairedServerWorkspaceRow> {
  const rows = new Map<string, PairedServerWorkspaceRow>()
  const add = (worktree: Worktree, kind: PairedServerWorkspaceRow['kind']): void => {
    if (!worktree.hostId || !hostIds.has(worktree.hostId)) {
      return
    }
    const key = getWorktreeHostIdentity(worktree)
    rows.set(key, {
      key,
      worktreeId: worktree.id,
      repoId: worktree.repoId,
      kind,
      path: worktree.path,
      branch: worktree.branch,
      displayName: worktree.displayName,
      isArchived: worktree.isArchived,
      isPinned: worktree.isPinned
    })
  }
  for (const worktree of getAllWorktreesFromState(state)) {
    add(worktree, 'git')
  }
  for (const folder of state.folderWorkspaces ?? []) {
    add(folderWorkspaceToWorktree(folder), 'folder')
  }
  return rows
}

function windowListedRepoIds(
  state: Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces'>
): Set<string> {
  return new Set([
    ...Object.keys(state.worktreesByRepo),
    ...(state.folderWorkspaces ?? []).map((folder) => folderWorkspaceRepoId(folder.projectGroupId))
  ])
}

async function readMainSnapshot() {
  const response = await window.api.runtime.call({ method: 'sidebarInputs.pairedServerRows' })
  const parsed = response.ok ? PairedServerRowsSnapshotSchema.safeParse(response.result) : null
  return parsed?.success ? parsed.data : null
}

export const pairedServerRowsShadow = defineSidebarShadowDomain<
  PairedServerWorkspaceRow,
  SidebarShadowMainRead<PairedServerWorkspaceRow> & { liveHostIds: ReadonlySet<string> }
>({
  name: 'paired-server-rows',
  readMain: async () => {
    const snapshot = await readMainSnapshot()
    if (!snapshot) {
      return null
    }
    // Only servers main last reached: an unverifiable server's rows are its last, not its current.
    const live = snapshot.servers.filter((server) => server.freshness === 'live')
    // Only projects the window has listed: it fetches a server's new project after main does.
    const listed = windowListedRepoIds(useAppStore.getState())
    return {
      revision: snapshot.revision,
      values: new Map(
        live.flatMap((server) =>
          server.rows.flatMap((row) => (listed.has(row.repoId) ? [[row.key, row] as const] : []))
        )
      ),
      liveHostIds: new Set(live.map((server) => server.hostId))
    }
  },
  readWindow: (main) => readWindowPairedServerRows(useAppStore.getState(), main.liveHostIds),
  equals: (window, main) => JSON.stringify(window ?? null) === JSON.stringify(main ?? null)
})

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

export const pairedServerHostsShadow = defineSidebarShadowDomain<
  PairedServerHostFacts,
  SidebarShadowMainRead<PairedServerHostFacts> & { hostIds: ReadonlySet<string> }
>({
  name: 'paired-server-hosts',
  readMain: async () => {
    const snapshot = await readMainSnapshot()
    if (!snapshot) {
      return null
    }
    return {
      revision: snapshot.revision,
      values: new Map(
        snapshot.servers.flatMap((server) =>
          server.host ? [[server.hostId, server.host] as const] : []
        )
      ),
      // Main lists only servers a phone may reach, never this desktop's own WSL hosts.
      hostIds: new Set(snapshot.servers.map((server) => server.hostId))
    }
  },
  readWindow: (main) => readWindowPairedServerHosts(useAppStore.getState(), main.hostIds),
  equals: (window, main) => JSON.stringify(window ?? null) === JSON.stringify(main ?? null)
})
