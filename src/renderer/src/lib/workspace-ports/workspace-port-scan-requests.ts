import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { WorkspacePortScanResult } from '../../../../shared/workspace/ports/workspace-ports'
import { runWorkspacePortScanForTarget } from './workspace-port-scan-client'

export function workspacePortRuntimeTargetKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

type InFlightWorkspacePortScan = {
  promise: Promise<WorkspacePortScanResult>
  freshOwners: boolean
  supersede: (refresh: Promise<WorkspacePortScanResult>) => void
}

// One request per target; entries leave when they settle.
const inFlightWorkspacePortScans = new Map<string, InFlightWorkspacePortScan>()

export async function scanWorkspacePortsForTarget(
  target: RuntimeClientTarget,
  repoId?: string,
  { freshOwners = false }: { freshOwners?: boolean } = {}
): Promise<WorkspacePortScanResult> {
  const key = JSON.stringify([workspacePortRuntimeTargetKey(target), repoId ?? null])
  const existing = inFlightWorkspacePortScans.get(key)
  // Coalesce same-tick surface refreshes to avoid duplicate lsof/netstat/RPC work.
  if (existing && (existing.freshOwners || !freshOwners)) {
    return existing.promise
  }

  // A manual Refresh outranks a background scan already running: that scan settles with the Refresh, when it does.
  let supersede: ((refresh: Promise<WorkspacePortScanResult>) => void) | undefined
  const promise = new Promise<WorkspacePortScanResult>((resolve, reject) => {
    supersede = resolve
    runWorkspacePortScanForTarget(target, repoId, freshOwners).then(resolve, reject)
  }).finally(() => {
    if (inFlightWorkspacePortScans.get(key) === entry) {
      inFlightWorkspacePortScans.delete(key)
    }
  })
  const entry: InFlightWorkspacePortScan = {
    promise,
    freshOwners,
    supersede: (refresh) => supersede?.(refresh)
  }
  existing?.supersede(promise)
  inFlightWorkspacePortScans.set(key, entry)
  return promise
}
