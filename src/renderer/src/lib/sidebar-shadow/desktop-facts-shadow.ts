import { useAppStore, type AppState } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import {
  DesktopSidebarFactsSchema,
  type DesktopSidebarFacts
} from '../../../../shared/sidebar-list/desktop-sidebar-facts'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { defineSidebarShadowDomain } from './sidebar-shadow-comparison'
import { toLocallyOwnedRows } from './workspace-activity-shadow'

type WindowFactsState = Pick<
  AppState,
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'worktreesByRepo'
  | 'folderWorkspaces'
  | 'repos'
  | 'workspaceHostOrder'
  | 'sshTargetLabels'
  | 'sshConnectionStates'
  | 'wslHostStatuses'
>

/** The same facts from the window's own store, in main's shape, for the rows the local runtime owns. */
export function readWindowDesktopSidebarFacts(state: WindowFactsState): DesktopSidebarFacts {
  const pinned = [
    ...getAllWorktreesFromState(state)
      .filter((worktree) => worktree.isPinned)
      .map((worktree) => worktree.id),
    ...state.folderWorkspaces
      .filter((folder) => folder.isPinned)
      .map((folder) => folderWorkspaceKey(folder.id))
  ]
  return {
    desktopActive: {
      hostId: state.activeWorkspaceExecutionHostId ?? null,
      worktreeId: state.activeWorktreeId ?? null
    },
    pinnedWorkspaceIds: [...new Set(pinned)].sort(),
    repoOrder: state.repos
      .map((repo) => ({ hostId: getRepoExecutionHostId(repo), repoId: repo.id }))
      .filter((entry) => parseExecutionHostId(entry.hostId)?.kind !== 'runtime'),
    workspaceHostOrder: [...state.workspaceHostOrder],
    sshHosts: Object.fromEntries(
      [...state.sshTargetLabels].map(([targetId, label]) => [
        toSshExecutionHostId(targetId),
        { label, status: state.sshConnectionStates.get(targetId)?.status ?? null }
      ])
    ),
    wslHosts: Object.fromEntries(
      Object.values(state.wslHostStatuses).map((status) => [
        toRuntimeExecutionHostId(status.environmentId),
        { distro: status.distro, state: status.state }
      ])
    )
  }
}

// One key per fact, so a mismatch names the fact; pins key per workspace the window lists locally.
function toComparedFacts(state: AppState, facts: DesktopSidebarFacts): Map<string, string> {
  const compared = new Map<string, string>([
    ['desktopActive', JSON.stringify(facts.desktopActive)],
    ['repoOrder', JSON.stringify(facts.repoOrder)],
    ['workspaceHostOrder', JSON.stringify(facts.workspaceHostOrder)]
  ])
  const pinned = toLocallyOwnedRows(
    state,
    new Map(facts.pinnedWorkspaceIds.map((id) => [id, 'pinned']))
  )
  for (const [id, value] of pinned) {
    compared.set(`pinned:${id}`, value)
  }
  for (const [hostId, host] of Object.entries({ ...facts.sshHosts, ...facts.wslHosts })) {
    compared.set(`host:${hostId}`, JSON.stringify(host))
  }
  return compared
}

export const desktopFactsShadow = defineSidebarShadowDomain<string>({
  name: 'desktop-facts',
  readWindow: () => {
    const state = useAppStore.getState()
    return toComparedFacts(state, readWindowDesktopSidebarFacts(state))
  },
  readMain: async () => {
    const response = await window.api.runtime.call({ method: 'sidebarInputs.desktopFacts' })
    const parsed = response.ok ? DesktopSidebarFactsSchema.safeParse(response.result) : null
    if (!parsed?.success) {
      return null
    }
    return { values: toComparedFacts(useAppStore.getState(), parsed.data) }
  },
  equals: (window, main) => window === main
})
