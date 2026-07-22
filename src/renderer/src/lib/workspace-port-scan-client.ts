import {
  callRuntimeRpc,
  RuntimeRpcCallError,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../shared/workspace-ports'

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
      {
        timeoutMs: 15_000
      }
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
