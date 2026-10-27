import {
  getProjectHostSetupProjectionFromState,
  type ProjectCatalogReadState
} from '@/store/project-host-setup-selector'
import type { LocalhostWorktreeLabelRoute } from '../../../shared/localhost-worktree-labels'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  getProjectHostSetupLookup,
  type WorkspaceProjectOwner
} from '../../../shared/project-host-setup-lookup'
import type { WorkspacePort } from '../../../shared/workspace-ports'
import { useAppStore } from '@/store'
import { localhostWorktreeLabelRouteForPort } from './workspace-port-localhost-label'

// Why: the port → repo → worktree → project resolution feeding
// localhostWorktreeLabelRouteForPort was duplicated across every ports surface;
// this is the single source for both reactive and imperative call sites.
type LocalhostLabelLookupState = ProjectCatalogReadState & {
  settings?: Pick<GlobalSettings, 'localhostWorktreeLabelsEnabled'> | null
  getKnownWorktreeById?: (worktreeId: string) => Partial<WorkspaceProjectOwner> | null | undefined
}

export function resolveLocalhostLabelRouteForPort(
  state: LocalhostLabelLookupState,
  port: WorkspacePort
): LocalhostWorktreeLabelRoute | null {
  if (port.kind !== 'workspace') {
    return null
  }
  const repo = (state.repos ?? []).find((entry) => entry.id === port.owner.repoId) ?? null
  const worktree = state.getKnownWorktreeById?.(port.owner.worktreeId) ?? null
  const projectId = getProjectHostSetupLookup(
    getProjectHostSetupProjectionFromState(state).setups
  ).projectId({
    ...worktree,
    repoId: port.owner.repoId
  })
  const project = projectId
    ? (getProjectHostSetupProjectionFromState(state).projects.find(
        (entry) => entry.id === projectId
      ) ?? null)
    : null
  return localhostWorktreeLabelRouteForPort({ port, repo, project, settings: state.settings })
}

export function useLocalhostLabelRouteForPort(
  port: WorkspacePort
): LocalhostWorktreeLabelRoute | null {
  const settings = useAppStore((s) => s.settings)
  const portWorktreeId = port.kind === 'workspace' ? port.owner.worktreeId : null
  const portRepoId = port.kind === 'workspace' ? port.owner.repoId : null
  const repo = useAppStore((s) =>
    portRepoId ? ((s.repos ?? []).find((entry) => entry.id === portRepoId) ?? null) : null
  )
  const worktree = useAppStore((s) =>
    portWorktreeId ? (s.getKnownWorktreeById?.(portWorktreeId) ?? null) : null
  )
  const projectId = useAppStore((s) =>
    portRepoId
      ? getProjectHostSetupLookup(getProjectHostSetupProjectionFromState(s).setups).projectId({
          ...worktree,
          repoId: portRepoId
        })
      : undefined
  )
  const project = useAppStore((s) =>
    projectId
      ? (getProjectHostSetupProjectionFromState(s).projects.find(
          (entry) => entry.id === projectId
        ) ?? null)
      : null
  )
  return localhostWorktreeLabelRouteForPort({ port, repo, project, settings })
}
