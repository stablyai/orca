import type { WorkspaceCreatorProvenance } from './worktree/types'

export function normalizeWorkspaceCreatorProvenance(
  value: unknown
): WorkspaceCreatorProvenance | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const candidate = value as { kind?: unknown; deviceId?: unknown }
  if (candidate.kind === 'host') {
    return { kind: 'host' }
  }
  if (
    candidate.kind === 'paired-device' &&
    typeof candidate.deviceId === 'string' &&
    candidate.deviceId.trim().length > 0
  ) {
    return { kind: 'paired-device', deviceId: candidate.deviceId }
  }
  return undefined
}

/** Who made a workspace, from one viewer's side: the viewer themselves, the host machine's own user,
 *  or another paired device. `viewerDeviceId` null is the host's own user. A workspace with no
 *  creator record is the viewer's: the sidebar shows it as theirs. */
export type WorkspaceCreatorRelation = 'viewer' | 'host' | 'other-device'

export function workspaceCreatorRelation(
  value: unknown,
  viewerDeviceId: string | null
): WorkspaceCreatorRelation {
  const creator = normalizeWorkspaceCreatorProvenance(value)
  if (!creator) {
    return 'viewer'
  }
  if (creator.kind === 'host') {
    return viewerDeviceId === null ? 'viewer' : 'host'
  }
  return creator.deviceId === viewerDeviceId ? 'viewer' : 'other-device'
}
