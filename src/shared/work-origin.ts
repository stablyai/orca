import type { WorkspaceCreatorProvenance } from './worktree/types'
import { normalizeWorkspaceCreatorProvenance } from './workspace-creator-provenance'

export type WorkOrigin = WorkspaceCreatorProvenance | null

export function normalizeWorkOrigin(value: unknown): WorkOrigin | undefined {
  if (value === undefined) {
    return undefined
  }
  return normalizeWorkspaceCreatorProvenance(value) ?? null
}

export function workOriginMatchesDevice(origin: WorkOrigin | undefined, deviceId: string): boolean {
  return origin?.kind === 'paired-device' && origin.deviceId === deviceId
}

export function workOriginAllowsHost(origin: WorkOrigin | undefined): boolean {
  // Legacy host-local sessions keep working; explicit unknown is never host ownership.
  return origin === undefined || origin?.kind === 'host'
}

export function workOriginAllowsDevice(
  origin: WorkOrigin | undefined,
  deviceId: string | undefined
): boolean {
  return (
    workOriginAllowsHost(origin) ||
    (deviceId !== undefined && workOriginMatchesDevice(origin, deviceId))
  )
}
