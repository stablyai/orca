import { parseExecutionHostId } from '../../execution-host/execution-host'
import type { ProjectGroupRemoteMember } from './project-group-types'

export function getProjectGroupRemoteMemberKey(hostId: string, projectId: string): string {
  return JSON.stringify([hostId, projectId])
}

/** Runtime-host members only: local and SSH projects join through this computer's own catalog. */
export function normalizeProjectGroupRemoteMembers(
  value: unknown,
  seen = new Set<string>()
): ProjectGroupRemoteMember[] {
  if (!Array.isArray(value)) {
    return []
  }
  const members: ProjectGroupRemoteMember[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') {
      continue
    }
    const hostId = 'hostId' in candidate ? candidate.hostId : null
    const projectId = 'projectId' in candidate ? candidate.projectId : null
    const order = 'order' in candidate ? candidate.order : null
    const host = parseExecutionHostId(typeof hostId === 'string' ? hostId : null)
    if (host?.kind !== 'runtime' || typeof projectId !== 'string' || !projectId) {
      continue
    }
    const key = getProjectGroupRemoteMemberKey(host.id, projectId)
    // A project sits in one group; the first group in tab order keeps a duplicate.
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    members.push({
      hostId: host.id,
      projectId,
      ...(typeof order === 'number' && Number.isFinite(order) ? { order } : {})
    })
  }
  return members
}
