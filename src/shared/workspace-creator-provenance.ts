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
