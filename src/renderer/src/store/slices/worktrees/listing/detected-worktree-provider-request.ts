import { callRuntimeRpc } from '../../../../runtime/runtime-rpc-client'
import { ipcOrRuntimeTargetForHostId } from '../../../../runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { getEnvironmentSshStateGeneration } from '../../runtime-environment-ssh'
import { getRuntimeEnvironmentConnectionGeneration } from '../../runtime-status'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import type { RuntimeWorktreeListResult } from '../../../../../../shared/runtime-types'
import type {
  HostQualifiedDetectedWorktreeResult,
  ListDetectedWorktreesArgs
} from '../../../../../../shared/detected-worktree-provider-contract'
import { REMOTE_WORKTREE_LIST_PARITY_LIMIT } from './worktree-slice-constants'
import type {
  BackgroundRuntimeRefreshOptions,
  DetectedWorktreeRefreshOptions
} from './worktree-slice-types'
import { isRuntimeMethodNotFoundError } from './runtime-worktree-rpc-errors'
import { toLegacyDetectedWorktreeResult } from './worktree-host-ownership'
import { isWorktreeScanFailureKind } from '../../../../../../shared/worktree-scan-failure'

/** The listing host is the one the caller asked about, never the focused one. */
export function detectedWorktreeTarget(executionHostId: ExecutionHostId): RuntimeClientTarget {
  const target = ipcOrRuntimeTargetForHostId(executionHostId)
  if (!target) {
    throw new Error('The workspace host is unresolved.')
  }
  return target
}

export async function listDetectedWorktreesForRepo(
  target: Extract<RuntimeClientTarget, { kind: 'environment' }>,
  repoId: string,
  options: BackgroundRuntimeRefreshOptions = {}
): Promise<DetectedWorktreeListResult> {
  try {
    return await callRuntimeRpc<DetectedWorktreeListResult>(
      target,
      'worktree.detectedList',
      { repo: repoId },
      {
        timeoutMs: 15_000,
        reuseRecentCompatibilityFailure: options.reuseRecentCompatibilityFailure
      }
    )
  } catch (error) {
    if (!isRuntimeMethodNotFoundError(error)) {
      throw error
    }
    const legacy = await callRuntimeRpc<RuntimeWorktreeListResult>(
      target,
      'worktree.list',
      { repo: repoId, limit: REMOTE_WORKTREE_LIST_PARITY_LIMIT },
      {
        timeoutMs: 15_000,
        reuseRecentCompatibilityFailure: options.reuseRecentCompatibilityFailure
      }
    )
    return toLegacyDetectedWorktreeResult(repoId, legacy)
  }
}

export function detectedWorktreeRefreshKey(
  repoId: string,
  options: DetectedWorktreeRefreshOptions
): string {
  const target = detectedWorktreeTarget(options.executionHostId)
  const targetKey = target.kind === 'local' ? 'local' : `runtime:${target.environmentId}`
  const parts = [
    repoId,
    options.executionHostId,
    targetKey,
    options.requireAuthoritative === true ? 'authoritative' : 'best-effort'
  ]
  // Remote foreground refresh must re-probe instead of joining cached-failure background scans; local has no preflight and still coalesces.
  if (target.kind === 'environment') {
    parts.push(`connection:${getEnvironmentSshStateGeneration(target.environmentId)}`)
    parts.push(`runtime:${getRuntimeEnvironmentConnectionGeneration(target.environmentId)}`)
    parts.push(options.reuseRecentCompatibilityFailure === true ? 'reuse-failure' : 'reprobe')
  }
  return parts.join('\n')
}

export function isDetectedWorktreeListResult(value: unknown): value is DetectedWorktreeListResult {
  if (!value || typeof value !== 'object') {
    return false
  }
  const result = value as Partial<DetectedWorktreeListResult>
  return (
    typeof result.repoId === 'string' &&
    typeof result.authoritative === 'boolean' &&
    (result.source === 'git' ||
      result.source === 'metadata-fallback' ||
      result.source === 'session-fallback') &&
    Array.isArray(result.worktrees) &&
    (result.failureKind === undefined || isWorktreeScanFailureKind(result.failureKind))
  )
}

export function rejectedDetectedWorktreeProviderResult(
  request: ListDetectedWorktreesArgs
): HostQualifiedDetectedWorktreeResult {
  return {
    providerRequestId: request.providerRequestId,
    executionHostId: request.executionHostId,
    status: 'rejected'
  }
}

export async function startDetectedWorktreeProviderRequest(
  request: ListDetectedWorktreesArgs
): Promise<HostQualifiedDetectedWorktreeResult> {
  const result = await window.api.worktrees.listDetected(request)
  if (result && typeof result === 'object' && 'status' in result && 'providerRequestId' in result) {
    return result as unknown as HostQualifiedDetectedWorktreeResult
  }
  // Why: web and older preload implementations return the legacy local shape.
  if (request.executionHostId === LOCAL_EXECUTION_HOST_ID && isDetectedWorktreeListResult(result)) {
    return {
      status: result.authoritative ? 'complete' : 'non-authoritative',
      providerRequestId: request.providerRequestId,
      repoId: request.repoId,
      authority: { kind: 'local', executionHostId: LOCAL_EXECUTION_HOST_ID },
      result
    }
  }
  return rejectedDetectedWorktreeProviderResult(request)
}
