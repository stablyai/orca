// Settings › Workspaces (team owners and admins): which rows the table shows for the By / In /
// search filters, and which actions each row offers. An action the control plane would refuse is
// never offered: only the owner or a team admin manages a workspace, Sleep needs it running, and
// Archive is refused while it is starting or mid-transition.
import type { CloudWorkspace } from '../../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { formatWorkspaceNumber } from '../../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import type { MemberDirectory } from '../../cloud-workspaces/cloud-workspace-format'

export const ANY = '__any'

export type TeamWorkspaceFilters = { by: string; repo: string; search: string }

export const INITIAL_TEAM_WORKSPACE_FILTERS: TeamWorkspaceFilters = {
  by: ANY,
  repo: ANY,
  search: ''
}

/** Who started a workspace; the owner when the control plane didn't record it. */
export function createdByOf(w: Pick<CloudWorkspace, 'createdBy' | 'ownerUserId'>): string {
  return w.createdBy || w.ownerUserId
}

/** The By filter's people and the In filter's repositories, from the listed workspaces. */
export function teamWorkspaceFilterOptions(workspaces: readonly CloudWorkspace[]): {
  people: string[]
  repos: string[]
} {
  return {
    people: [...new Set(workspaces.map(createdByOf))],
    repos: [...new Set(workspaces.flatMap((w) => (w.repo ? [w.repo.url] : [])))].sort()
  }
}

function matchesSearch(w: CloudWorkspace, search: string, directory: MemberDirectory): boolean {
  const needle = search.trim().toLowerCase()
  if (!needle) {
    return true
  }
  return [
    w.title,
    w.repo?.url,
    w.repo?.branch,
    w.number ? formatWorkspaceNumber(w.number) : null,
    directory.get(createdByOf(w))?.name,
    w.memberNames?.[createdByOf(w)]
  ].some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))
}

export function teamWorkspaceRows(
  workspaces: readonly CloudWorkspace[],
  filters: TeamWorkspaceFilters,
  directory: MemberDirectory
): CloudWorkspace[] {
  return workspaces
    .filter(
      (w) =>
        (filters.by === ANY || createdByOf(w) === filters.by) &&
        (filters.repo === ANY || w.repo?.url === filters.repo) &&
        matchesSearch(w, filters.search, directory)
    )
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
}

export type TeamWorkspaceActions = { open: boolean; sleep: boolean; archive: boolean }

export function teamWorkspaceActions(
  w: Pick<CloudWorkspace, 'access' | 'archivedAt' | 'status'>,
  canAdmin: boolean
): TeamWorkspaceActions {
  const live = w.archivedAt === null
  const manage = live && (w.access === 'owner' || canAdmin)
  return {
    // Opening pairs this computer through a grant; a workspace you can't open has none to give.
    open: live && w.access !== 'none',
    sleep: manage && w.status === 'running',
    archive: manage && (w.status === 'running' || w.status === 'suspended' || w.status === 'failed')
  }
}
