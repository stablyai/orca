import type { ExecutionHostId } from '../execution-host'
import { getRepoExecutionHostIdOrDefault } from '../execution-host'
import { getHostContextLabel } from '../worktree/row-display/host-context-labels'
import type { ImportedWorktreesCardCandidate, Row } from './row-types'

/**
 * Outside project grouping no header owns a project, so one line at the end of the list covers
 * every project's hidden worktrees. A line per host lets host sections file it under its host.
 */
export function appendImportedWorktreeLines(
  rows: Row[],
  args: {
    importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
    defaultHostId: ExecutionHostId
    hostLabelById?: ReadonlyMap<string, string>
  }
): Row[] {
  const projectsByHostId = new Map<ExecutionHostId, ImportedWorktreesCardCandidate[]>()
  for (const candidate of args.importedWorktreesByRepo.values()) {
    const hostId = getRepoExecutionHostIdOrDefault(candidate.repo, args.defaultHostId)
    const projects = projectsByHostId.get(hostId)
    if (projects) {
      projects.push(candidate)
    } else {
      projectsByHostId.set(hostId, [candidate])
    }
  }
  const nameHosts = projectsByHostId.size > 1
  for (const [hostId, projects] of projectsByHostId) {
    const hostLabel = nameHosts
      ? getHostContextLabel(hostId, { hostLabelById: args.hostLabelById })
      : undefined
    rows.push({
      type: 'imported-worktrees-card',
      key: `imported-worktrees-card:all-projects:${hostId}`,
      placement: 'all-projects',
      hostId,
      projects,
      ...(hostLabel ? { hostContextLabel: hostLabel, hostContextHostId: hostId } : {})
    })
  }
  return rows
}
