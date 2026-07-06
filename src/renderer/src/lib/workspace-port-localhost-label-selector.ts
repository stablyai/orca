import type { LocalhostWorktreeLabelRoute } from '../../../shared/localhost-worktree-labels'
import type { GlobalSettings, Project, Repo } from '../../../shared/types'
import type { WorkspacePort } from '../../../shared/workspace-ports'
import { useAppStore } from '@/store'
import { localhostWorktreeLabelRouteForPort } from './workspace-port-localhost-label'

// Why: the port → repo → worktree → project resolution feeding
// localhostWorktreeLabelRouteForPort was duplicated across every ports surface;
// this is the single source for both reactive and imperative call sites.
type LocalhostLabelLookupState = {
  settings?: Pick<GlobalSettings, 'localhostWorktreeLabelsEnabled'> | null
  repos?: Repo[]
  projects?: Project[]
  getKnownWorktreeById?: (worktreeId: string) => { projectId?: string | null } | null | undefined
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
  const project = worktree?.projectId
    ? ((state.projects ?? []).find((entry) => entry.id === worktree.projectId) ?? null)
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
  const project = useAppStore((s) =>
    worktree?.projectId
      ? ((s.projects ?? []).find((entry) => entry.id === worktree.projectId) ?? null)
      : null
  )
  return localhostWorktreeLabelRouteForPort({ port, repo, project, settings })
}
