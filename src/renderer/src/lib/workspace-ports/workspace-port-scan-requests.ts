import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { WorkspacePortScanResult } from '../../../../shared/workspace/ports/workspace-ports'
import { runWorkspacePortScanForTarget } from './workspace-port-scan-client'

export function workspacePortRuntimeTargetKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

const inFlightWorkspacePortScans = new Map<string, Promise<WorkspacePortScanResult>>()
// Latest manual Refresh per target, so a background scan that started before it cannot repaint older owners.
const latestFreshWorkspacePortScans = new Map<
  string,
  { sequence: number; promise: Promise<WorkspacePortScanResult> }
>()
let workspacePortScanSequence = 0

function workspacePortScanRequestKey(
  target: RuntimeClientTarget,
  repoId: string | undefined,
  freshOwners: boolean
): string {
  return JSON.stringify([workspacePortRuntimeTargetKey(target), repoId ?? null, freshOwners])
}

export async function scanWorkspacePortsForTarget(
  target: RuntimeClientTarget,
  repoId?: string,
  { freshOwners = false }: { freshOwners?: boolean } = {}
): Promise<WorkspacePortScanResult> {
  const key = workspacePortScanRequestKey(target, repoId, freshOwners)
  const existing = inFlightWorkspacePortScans.get(key)
  if (existing) {
    return existing
  }

  const sequence = ++workspacePortScanSequence
  const backgroundKey = workspacePortScanRequestKey(target, repoId, false)
  // Coalesce same-tick surface refreshes to avoid duplicate lsof/netstat/RPC work.
  const promise = runWorkspacePortScanForTarget(target, repoId, freshOwners)
    .then((result) => {
      const fresh = freshOwners ? undefined : latestFreshWorkspacePortScans.get(backgroundKey)
      return fresh && fresh.sequence > sequence ? fresh.promise.catch(() => result) : result
    })
    .finally(() => {
      if (inFlightWorkspacePortScans.get(key) === promise) {
        inFlightWorkspacePortScans.delete(key)
      }
    })
  inFlightWorkspacePortScans.set(key, promise)
  if (freshOwners) {
    latestFreshWorkspacePortScans.set(backgroundKey, { sequence, promise })
  }
  return promise
}
