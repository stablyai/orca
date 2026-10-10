import {
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability,
  RuntimeRpcCallError,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { callHostRoute } from '@/runtime/host-route-call'
import type { HostRoute } from '@/runtime/runtime-client-target'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type {
  WorkspacePort,
  WorkspacePortHostScanResult,
  WorkspacePortKillResult,
  WorkspacePortScanResult
} from '../../../shared/workspace-ports'
import { normalizeExecutionHostId } from '../../../shared/execution-host'
import { WORKSPACE_PORTS_HOST_SCOPED_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

export const WORKSPACE_PORTS_SERVER_SSH_UPDATE_REASON =
  'Update the server to see ports on its SSH hosts.'
const WORKSPACE_PORT_RPC_TIMEOUT_MS = 15_000

const WORKSPACE_PORT_PLATFORMS = new Set<NodeJS.Platform | 'unknown'>([
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'unknown',
  'win32'
])
const WORKSPACE_PORT_PROTOCOLS = new Set<WorkspacePort['protocol']>(['http', 'https', 'unknown'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function isWorkspacePortOwner(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value.worktreeId === 'string' &&
    typeof value.repoId === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.path === 'string' &&
    (value.confidence === 'cwd' || value.confidence === 'command' || value.confidence === 'none')
  )
}

function isWorkspacePort(value: unknown): value is WorkspacePort {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.bindHost !== 'string' ||
    typeof value.connectHost !== 'string' ||
    typeof value.port !== 'number' ||
    !Number.isFinite(value.port) ||
    !isOptionalFiniteNumber(value.pid) ||
    !isOptionalString(value.processName) ||
    !WORKSPACE_PORT_PROTOCOLS.has(value.protocol as WorkspacePort['protocol'])
  ) {
    return false
  }
  if (value.kind === 'workspace') {
    return isWorkspacePortOwner(value.owner) && isOptionalString(value.advertisedUrl)
  }
  return value.kind === 'container' || value.kind === 'external'
}

function requireWorkspacePortScanResult(value: unknown): WorkspacePortScanResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.ports) ||
    !value.ports.every(isWorkspacePort) ||
    !WORKSPACE_PORT_PLATFORMS.has(value.platform as NodeJS.Platform | 'unknown') ||
    typeof value.scannedAt !== 'number' ||
    !Number.isFinite(value.scannedAt) ||
    ('unavailableReason' in value &&
      value.unavailableReason !== undefined &&
      typeof value.unavailableReason !== 'string')
  ) {
    throw new Error('Workspace port scan returned an invalid response.')
  }
  return value as unknown as WorkspacePortScanResult
}

export async function runWorkspacePortScanForTarget(
  target: RuntimeClientTarget,
  repoId?: string
): Promise<WorkspacePortScanResult> {
  const params = repoId ? { repoId } : {}
  if (target.kind === 'local') {
    return requireWorkspacePortScanResult(await window.api.workspacePorts.scan(params))
  }
  try {
    const result = await callRuntimeRpc<WorkspacePortScanResult>(
      target,
      'workspacePorts.scan',
      params,
      { timeoutMs: WORKSPACE_PORT_RPC_TIMEOUT_MS }
    )
    return requireWorkspacePortScanResult(result)
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return {
        platform: 'unknown',
        scannedAt: Date.now(),
        ports: [],
        unavailableReason: 'The connected runtime does not support workspace port management yet.'
      }
    }
    throw error
  }
}

/** An SSH host scanned by the endpoint that owns it, addressed as the panel resolved it. */
export type HostScopedPortHost = {
  route: HostRoute
  executionHostId: string
  worktreeId: string
}

function unavailableHostScan(executionHostId: string, reason: string): WorkspacePortHostScanResult {
  return {
    executionHostId,
    platform: 'unknown',
    scannedAt: Date.now(),
    ports: [],
    unavailableReason: reason
  }
}

function isMethodNotFound(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
}

/**
 * Asks the owning endpoint to scan the host the workspace runs on. An older server only knows how to
 * scan itself, so it is never asked: its answer would show the server's ports for the SSH workspace.
 */
export async function scanWorkspacePortsOnExecutionHost(
  host: HostScopedPortHost
): Promise<WorkspacePortHostScanResult> {
  const { target } = host.route
  if (
    target.kind === 'environment' &&
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      WORKSPACE_PORTS_HOST_SCOPED_RUNTIME_CAPABILITY
    ))
  ) {
    return unavailableHostScan(host.executionHostId, WORKSPACE_PORTS_SERVER_SSH_UPDATE_REASON)
  }
  let response: unknown
  try {
    response = await callHostRoute(
      host.route,
      'workspacePorts.scanHost',
      { worktree: toRuntimeWorktreeSelector(host.worktreeId) },
      { timeoutMs: WORKSPACE_PORT_RPC_TIMEOUT_MS }
    )
  } catch (error) {
    if (isMethodNotFound(error)) {
      return unavailableHostScan(host.executionHostId, WORKSPACE_PORTS_SERVER_SSH_UPDATE_REASON)
    }
    throw error
  }
  const scan = requireWorkspacePortScanResult(response)
  const scannedHostId = isRecord(response) ? response.executionHostId : undefined
  const expected = normalizeExecutionHostId(host.executionHostId)
  // Why: rows belong to one host; a server that resolved the workspace elsewhere must not fill them.
  if (typeof scannedHostId !== 'string' || normalizeExecutionHostId(scannedHostId) !== expected) {
    return unavailableHostScan(
      host.executionHostId,
      'The server scanned a different host than this workspace runs on.'
    )
  }
  return { ...scan, executionHostId: scannedHostId }
}

/** Stops a row on the host it was scanned on; the server refuses when the workspace moved. */
export async function killWorkspacePortOnExecutionHost(
  host: HostScopedPortHost,
  row: { scannedHostId: string; pid: number; port: number }
): Promise<WorkspacePortKillResult> {
  try {
    return await callHostRoute<WorkspacePortKillResult>(
      host.route,
      'workspacePorts.killHost',
      {
        worktree: toRuntimeWorktreeSelector(host.worktreeId),
        executionHostId: row.scannedHostId,
        pid: row.pid,
        port: row.port
      },
      { timeoutMs: WORKSPACE_PORT_RPC_TIMEOUT_MS }
    )
  } catch (error) {
    if (isMethodNotFound(error)) {
      return { ok: false, reason: WORKSPACE_PORTS_SERVER_SSH_UPDATE_REASON }
    }
    throw error
  }
}
