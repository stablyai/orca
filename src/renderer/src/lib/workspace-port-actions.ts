import type { useAppStore } from '@/store'
import {
  callRuntimeRpc,
  RuntimeRpcCallError,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type {
  WorkspacePort,
  WorkspacePortKillResult,
  WorkspacePortScanResult
} from '../../../shared/workspace-ports'
import { runWorkspacePortScanForTarget } from './workspace-port-scan-client'

export { addressForPort } from './workspace-port-urls'
export {
  getPortOpenBrowserTooltipLabel,
  getPortSystemBrowserHint,
  goToWorkspacePortOwner,
  openWorkspacePortInBrowser,
  resolvePortOpenInOrcaBrowser,
  shouldOpenWorkspacePortInOrcaBrowser,
  workspacePortOwnerWorktreeId
} from './workspace-port-browser-open'

const WORKSPACE_PORT_STOP_SETTLE_MS = 500

export function canStopWorkspacePort(
  port: WorkspacePort
): port is WorkspacePort & { kind: 'workspace'; pid: number } {
  return port.kind === 'workspace' && Boolean(port.pid) && port.processName !== 'Electron'
}

type WorkspacePortScanSetter = ReturnType<typeof useAppStore.getState>['setWorkspacePortScan']
type WorkspacePortScanByKeySetter = ReturnType<
  typeof useAppStore.getState
>['setWorkspacePortScanForKey']
type WorkspacePortScanRefreshingSetter = ReturnType<
  typeof useAppStore.getState
>['setWorkspacePortScanRefreshing']

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export async function refreshWorkspacePortScanAfterStop(args: {
  runtimeTarget: RuntimeClientTarget
  setWorkspacePortScan: WorkspacePortScanSetter
  setWorkspacePortScanForKey?: WorkspacePortScanByKeySetter
  setWorkspacePortScanRefreshing: WorkspacePortScanRefreshingSetter
  getWorkspacePortScansByKey?: () => Record<string, WorkspacePortScanResult>
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const scanKey = workspacePortScanKeyForTarget(args.runtimeTarget)
  const publishScan = (scan: WorkspacePortScanResult): void => {
    args.setWorkspacePortScanForKey?.(scanKey, scan)
    const currentScans = args.getWorkspacePortScansByKey?.() ?? {}
    const merged = mergeWorkspacePortScans({ ...currentScans, [scanKey]: scan })
    args.setWorkspacePortScan({
      key: merged && Object.keys(currentScans).length > 0 ? 'all-hosts:all' : scanKey,
      result: merged ?? scan
    })
  }
  args.setWorkspacePortScanRefreshing(true)
  try {
    let firstScan: WorkspacePortScanResult
    try {
      firstScan = await scanWorkspacePortsForTarget(args.runtimeTarget)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: message || 'Workspace port scan failed.' }
    }
    publishScan(firstScan)

    // Why: stopping sends SIGTERM, and the listener can remain visible for a
    // short window. A settled re-scan keeps worktree cards from showing a stale
    // port row after the process actually exits. Failures here are swallowed
    // because the UI is already correct from the first scan; surfacing a
    // 'Failed to refresh ports' toast on top of the stop success would lie.
    await delay(WORKSPACE_PORT_STOP_SETTLE_MS)
    try {
      const settledScan = await scanWorkspacePortsForTarget(args.runtimeTarget)
      publishScan(settledScan)
    } catch {
      // Intentionally ignored: first scan already updated the UI.
    }
    return { ok: true }
  } finally {
    args.setWorkspacePortScanRefreshing(false)
  }
}

export function workspacePortRuntimeTargetKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

export function runtimeTargetForExecutionHostId(
  hostId: ExecutionHostId
): RuntimeClientTarget | null {
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind === 'local') {
    return { kind: 'local' }
  }
  if (parsed?.kind === 'runtime') {
    return { kind: 'environment', environmentId: parsed.environmentId }
  }
  // Why: no RuntimeClientTarget exists for SSH hosts yet — workspace port
  // scanning only runs against local and runtime (environment) targets today.
  return null
}

export function workspacePortScanKeyForTarget(target: RuntimeClientTarget): string {
  return `${workspacePortRuntimeTargetKey(target)}:all`
}

export function mergeWorkspacePortScans(
  scansByKey: Record<string, WorkspacePortScanResult>
): WorkspacePortScanResult | null {
  const entries = Object.entries(scansByKey)
    .filter(([, scan]) => scan)
    .sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) {
    return null
  }
  if (entries.length === 1) {
    return entries[0][1]
  }
  const ports = entries.flatMap(([key, scan]) =>
    scan.ports.map((port) => ({
      ...port,
      // Why: local and runtime scanners can both report simple ids like
      // `tcp:3000`; aggregate All-hosts views need stable unique row keys.
      id: `${key}:${port.id}`
    }))
  )
  const unavailable = entries
    .map(([key, scan]) => (scan.unavailableReason ? `${key}: ${scan.unavailableReason}` : null))
    .filter((entry): entry is string => entry !== null)
  const allEntriesUnavailable = unavailable.length === entries.length && unavailable.length > 0
  return {
    platform: 'unknown',
    scannedAt: Math.max(...entries.map(([, scan]) => scan.scannedAt)),
    ports,
    ...(allEntriesUnavailable ? { unavailableReason: unavailable.join('; ') } : {})
  }
}

const inFlightWorkspacePortScans = new Map<string, Promise<WorkspacePortScanResult>>()

function workspacePortScanRequestKey(target: RuntimeClientTarget, repoId?: string): string {
  return JSON.stringify([workspacePortRuntimeTargetKey(target), repoId ?? null])
}

export async function scanWorkspacePortsForTarget(
  target: RuntimeClientTarget,
  repoId?: string
): Promise<WorkspacePortScanResult> {
  const key = workspacePortScanRequestKey(target, repoId)
  const existing = inFlightWorkspacePortScans.get(key)
  if (existing) {
    return existing
  }

  // Why: visible surfaces can request the same scan on the same tick
  // (focus refresh, status bar, side panel, stop refresh). Share it so one
  // UI burst cannot fan out into duplicate lsof/netstat/RPC work.
  const promise = runWorkspacePortScanForTarget(target, repoId).finally(() => {
    if (inFlightWorkspacePortScans.get(key) === promise) {
      inFlightWorkspacePortScans.delete(key)
    }
  })
  inFlightWorkspacePortScans.set(key, promise)
  return promise
}

export async function killWorkspacePortForTarget(
  target: RuntimeClientTarget,
  args: { repoId: string; pid: number; port: number }
): Promise<WorkspacePortKillResult> {
  if (target.kind === 'local') {
    return window.api.workspacePorts.kill(args)
  }
  try {
    return await callRuntimeRpc<WorkspacePortKillResult>(target, 'workspacePorts.kill', args, {
      timeoutMs: 15_000
    })
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return {
        ok: false,
        reason: 'The connected runtime does not support workspace port management yet.'
      }
    }
    throw error
  }
}
