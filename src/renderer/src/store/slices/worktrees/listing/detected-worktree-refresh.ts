import { getActiveRuntimeTarget } from '../../../../runtime/runtime-rpc-client'
import { getEnvironmentSshStateGeneration } from '../../runtime-environment-ssh'
import { getRuntimeEnvironmentConnectionGeneration } from '../../runtime-status'
import {
  createDetectedWorktreeRefreshLeaseRegistry,
  type DetectedWorktreeRefreshLease
} from '../../detected-worktree-refresh-leases'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { AppState } from '../../../types'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import type {
  HostQualifiedDetectedWorktreeResult,
  ProviderRequestId,
  SshExecutionHostId
} from '../../../../../../shared/detected-worktree-provider-contract'
import type {
  DetectedWorktreeRefreshOptions,
  DetectedWorktreeRefreshOutcome
} from './worktree-slice-types'
import { teardownMissingWorktreeTerminalsBestEffort } from '../teardown/missing-worktree-terminal-teardown'
import { directSshAuthorityIsComplete } from './direct-ssh-authority'
import {
  detectedWorktreeRefreshKey,
  isDetectedWorktreeListResult,
  listDetectedWorktreesForRepo,
  startDetectedWorktreeProviderRequest
} from './detected-worktree-provider-request'

const runtimeDetectedWorktreeRefreshesInFlight = new Map<
  string,
  Promise<DetectedWorktreeListResult>
>()

const STALE_RUNTIME_GENERATION_ERROR = 'runtime_environment_generation_changed'
// Why exactly one: a second stale answer means the connection is still churning, and
// retrying into that would stall the caller instead of letting it fail visibly.
const STALE_RUNTIME_GENERATION_RETRIES = 1

export function isStaleRuntimeGenerationError(error: unknown): boolean {
  return error instanceof Error && error.message === STALE_RUNTIME_GENERATION_ERROR
}

export const detectedWorktreeRefreshLeaseRegistry = createDetectedWorktreeRefreshLeaseRegistry({
  startProviderRequest: startDetectedWorktreeProviderRequest,
  cancelProviderRequest: async (request) => {
    await window.api.worktrees.cancelListDetected?.({
      providerRequestId: request.providerRequestId
    })
  }
})

export function acquireDetectedWorktreeRefreshLeaseForRepo(
  settings: AppState['settings'],
  repoId: string,
  options: DetectedWorktreeRefreshOptions
): DetectedWorktreeRefreshLease {
  const parsedHost = parseExecutionHostId(options.executionHostId)
  if (!parsedHost || parsedHost.kind === 'runtime') {
    throw new Error('Provider leases require a local or direct SSH execution host')
  }
  const publicKey = detectedWorktreeRefreshKey(settings, repoId, options)
  if (parsedHost.kind === 'local') {
    return detectedWorktreeRefreshLeaseRegistry.acquire(publicKey, {
      repoId,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
  }
  if (
    !options.directSshAuthority ||
    !directSshAuthorityIsComplete(options.directSshAuthority, parsedHost.targetId)
  ) {
    throw new Error('Direct SSH provider leases require exact target authority')
  }
  return detectedWorktreeRefreshLeaseRegistry.acquire(publicKey, {
    repoId,
    executionHostId: options.executionHostId as SshExecutionHostId,
    expectedAuthority: { ...options.directSshAuthority }
  })
}

export function qualifiedProviderResultIsAdmitted(
  result: HostQualifiedDetectedWorktreeResult,
  providerRequestId: ProviderRequestId,
  repoId: string,
  options: DetectedWorktreeRefreshOptions
): result is Extract<
  HostQualifiedDetectedWorktreeResult,
  { status: 'complete' | 'non-authoritative' }
> {
  if (
    result.providerRequestId !== providerRequestId ||
    (result.status !== 'complete' && result.status !== 'non-authoritative') ||
    !isDetectedWorktreeListResult(result.result) ||
    !result.authority ||
    result.repoId !== repoId ||
    result.result.repoId !== repoId ||
    result.result.authoritative !== (result.status === 'complete')
  ) {
    return false
  }
  const parsedHost = parseExecutionHostId(options.executionHostId)
  if (parsedHost?.kind === 'local') {
    return (
      result.authority.kind === 'local' &&
      result.authority.executionHostId === LOCAL_EXECUTION_HOST_ID
    )
  }
  const expected = options.directSshAuthority
  return (
    parsedHost?.kind === 'ssh' &&
    expected !== undefined &&
    result.authority.kind === 'direct-ssh' &&
    result.authority.executionHostId === options.executionHostId &&
    result.authority.targetId === expected.targetId &&
    result.authority.providerEpoch === expected.providerEpoch &&
    result.authority.connectionGeneration === expected.connectionGeneration
  )
}

export function normalizeNotAdmittedProviderResult(
  result: HostQualifiedDetectedWorktreeResult,
  providerRequestId: ProviderRequestId,
  executionHostId: ExecutionHostId
): HostQualifiedDetectedWorktreeResult {
  if (
    result.providerRequestId === providerRequestId &&
    result.status !== 'complete' &&
    result.status !== 'non-authoritative' &&
    'executionHostId' in result &&
    result.executionHostId === executionHostId
  ) {
    return result
  }
  return {
    providerRequestId,
    executionHostId,
    status: 'rejected'
  }
}

async function listDetectedWorktreesForRuntimeRepoOnce(
  settings: AppState['settings'],
  repoId: string,
  options: DetectedWorktreeRefreshOptions,
  environmentId: string
): Promise<DetectedWorktreeRefreshOutcome> {
  // Why recomputed per attempt: the key embeds both generations, so a retry after a
  // reconnect must not join the superseded connection's in-flight scan.
  const key = detectedWorktreeRefreshKey(settings, repoId, options)
  const connectionGeneration = getEnvironmentSshStateGeneration(environmentId)
  const runtimeConnectionGeneration = getRuntimeEnvironmentConnectionGeneration(environmentId)
  let refresh = runtimeDetectedWorktreeRefreshesInFlight.get(key)
  if (!refresh) {
    refresh = listDetectedWorktreesForRepo(settings, repoId, {
      reuseRecentCompatibilityFailure: options.reuseRecentCompatibilityFailure
    })
    runtimeDetectedWorktreeRefreshesInFlight.set(key, refresh)
  }
  try {
    const result = await refresh
    if (
      getEnvironmentSshStateGeneration(environmentId) !== connectionGeneration ||
      getRuntimeEnvironmentConnectionGeneration(environmentId) !== runtimeConnectionGeneration
    ) {
      throw new Error(STALE_RUNTIME_GENERATION_ERROR)
    }
    // Why (#10562): the scan coalesces, but teardown must not — each caller carries
    // its own known-id snapshot and purges its own state, so a caller that joined
    // an in-flight scan would otherwise purge without ever stopping those terminals.
    await teardownMissingWorktreeTerminalsBestEffort(
      settings,
      repoId,
      options.connectionId,
      options.knownWorktreeIds,
      result
    )
    return {
      status: 'admitted',
      result,
      executionHostId: options.executionHostId,
      runtimeAuthority: {
        environmentId,
        connectionGeneration,
        runtimeConnectionGeneration
      }
    }
  } finally {
    if (runtimeDetectedWorktreeRefreshesInFlight.get(key) === refresh) {
      runtimeDetectedWorktreeRefreshesInFlight.delete(key)
    }
  }
}

export async function listDetectedWorktreesForRepoCoalesced(
  settings: AppState['settings'],
  repoId: string,
  options: DetectedWorktreeRefreshOptions
): Promise<DetectedWorktreeRefreshOutcome> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await listDetectedWorktreesForRuntimeRepoOnce(
          settings,
          repoId,
          options,
          target.environmentId
        )
      } catch (err) {
        // Why re-read instead of surfacing: the fence proves this answer predates the
        // current connection, not that the repo has no worktrees. Callers drop the repo
        // on any throw, so a discarded scan left those rows absent until an unrelated
        // refresh happened to run (#19241).
        if (attempt >= STALE_RUNTIME_GENERATION_RETRIES || !isStaleRuntimeGenerationError(err)) {
          throw err
        }
      }
    }
  }

  const lease = acquireDetectedWorktreeRefreshLeaseForRepo(settings, repoId, options)
  let providerResult: HostQualifiedDetectedWorktreeResult
  try {
    providerResult = await lease.result
  } catch {
    return {
      status: 'not-admitted',
      providerResult: {
        providerRequestId: lease.providerRequestId,
        executionHostId: options.executionHostId,
        status: 'rejected'
      },
      executionHostId: options.executionHostId,
      directSshAuthority: options.directSshAuthority
    }
  }
  if (
    !qualifiedProviderResultIsAdmitted(providerResult, lease.providerRequestId, repoId, options)
  ) {
    return {
      status: 'not-admitted',
      providerResult: normalizeNotAdmittedProviderResult(
        providerResult,
        lease.providerRequestId,
        options.executionHostId
      ),
      executionHostId: options.executionHostId,
      directSshAuthority: options.directSshAuthority
    }
  }
  await teardownMissingWorktreeTerminalsBestEffort(
    settings,
    repoId,
    options.connectionId,
    options.knownWorktreeIds,
    providerResult.result
  )
  return {
    status: 'admitted',
    result: providerResult.result,
    providerResult,
    executionHostId: options.executionHostId,
    directSshAuthority: options.directSshAuthority
  }
}
