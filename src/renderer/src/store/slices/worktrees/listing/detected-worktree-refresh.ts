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

const runtimeDetectedWorktreeRefreshStartedAt = new Map<string, number>()
const runtimeDetectedWorktreeRefreshesInFlight = new Map<
  string,
  Promise<DetectedWorktreeListResult>
>()

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

export async function listDetectedWorktreesForRepoCoalesced(
  settings: AppState['settings'],
  repoId: string,
  options: DetectedWorktreeRefreshOptions
): Promise<DetectedWorktreeRefreshOutcome> {
  const key = detectedWorktreeRefreshKey(settings, repoId, options)
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    const connectionGeneration = getEnvironmentSshStateGeneration(target.environmentId)
    const runtimeConnectionGeneration = getRuntimeEnvironmentConnectionGeneration(
      target.environmentId
    )
    let refresh = runtimeDetectedWorktreeRefreshesInFlight.get(key)
    if (!refresh) {
      refresh = listDetectedWorktreesForRepo(settings, repoId, {
        reuseRecentCompatibilityFailure: options.reuseRecentCompatibilityFailure
      })
      runtimeDetectedWorktreeRefreshesInFlight.set(key, refresh)
      runtimeDetectedWorktreeRefreshStartedAt.set(key, Date.now())
    }
    // Why: a joining caller started later than the scan it shares; the merge fences on the
    // scan's start, or a write that landed between the two would be undone by pre-write data.
    const startedAt = runtimeDetectedWorktreeRefreshStartedAt.get(key)
    try {
      const result = await refresh
      if (
        getEnvironmentSshStateGeneration(target.environmentId) !== connectionGeneration ||
        getRuntimeEnvironmentConnectionGeneration(target.environmentId) !==
          runtimeConnectionGeneration
      ) {
        throw new Error('runtime_environment_generation_changed')
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
        startedAt,
        executionHostId: options.executionHostId,
        runtimeAuthority: {
          environmentId: target.environmentId,
          connectionGeneration,
          runtimeConnectionGeneration
        }
      }
    } finally {
      if (runtimeDetectedWorktreeRefreshesInFlight.get(key) === refresh) {
        runtimeDetectedWorktreeRefreshesInFlight.delete(key)
        runtimeDetectedWorktreeRefreshStartedAt.delete(key)
      }
    }
  }

  const lease = acquireDetectedWorktreeRefreshLeaseForRepo(settings, repoId, options)
  const startedAt = rememberLeaseStart(lease.providerRequestId)
  try {
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
      startedAt,
      providerResult,
      executionHostId: options.executionHostId,
      directSshAuthority: options.directSshAuthority
    }
  } finally {
    forgetLeaseStart(lease.providerRequestId)
  }
}

// Why keyed by provider request: the lease registry hands every joiner the same request id, so
// the first acquire's clock is the scan's start for all of them. An entry lives while any holder
// still awaits that request and is forgotten when the last one releases it, so a joiner arriving
// late in a long scan still inherits the original clock. The TTL is only a leak guard for a holder
// that never releases, set far beyond any listing an active request could still be serving.
const LEASE_START_TTL_MS = 10 * 60_000
type LeaseStart = { startedAt: number; holders: number }
const leaseStartedAtByRequestId = new Map<string, LeaseStart>()

export function rememberLeaseStart(providerRequestId: string): number {
  const now = Date.now()
  for (const [id, entry] of leaseStartedAtByRequestId) {
    if (now - entry.startedAt > LEASE_START_TTL_MS) {
      leaseStartedAtByRequestId.delete(id)
    }
  }
  const existing = leaseStartedAtByRequestId.get(providerRequestId)
  if (existing) {
    existing.holders += 1
    return existing.startedAt
  }
  leaseStartedAtByRequestId.set(providerRequestId, { startedAt: now, holders: 1 })
  return now
}

/** Pairs with rememberLeaseStart: called once per holder when its provider request has settled. */
export function forgetLeaseStart(providerRequestId: string): void {
  const entry = leaseStartedAtByRequestId.get(providerRequestId)
  if (!entry) {
    return
  }
  entry.holders -= 1
  if (entry.holders <= 0) {
    leaseStartedAtByRequestId.delete(providerRequestId)
  }
}
