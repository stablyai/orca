import type {
  DirectSshDetectedWorktreeRequest,
  HostQualifiedDetectedWorktreeResult,
  ListDetectedWorktreesArgs,
  LocalDetectedWorktreeRequest,
  ProviderRequestId
} from '../../../../shared/detected-worktree-provider-contract'

export type WaiterLeaseId = string & {
  readonly __waiterLeaseId: unique symbol
}

export type DetectedWorktreeRefreshReleaseReason = 'superseded' | 'invalidated' | 'stopped'

export type DetectedWorktreeRefreshReleaseOutcome =
  | 'retained'
  | 'cancel-started'
  | 'cancel-failed'
  | 'already-settled'

export type DetectedWorktreeRefreshLease = {
  waiterLeaseId: WaiterLeaseId
  providerRequestId: ProviderRequestId
  result: Promise<HostQualifiedDetectedWorktreeResult>
  release(reason: DetectedWorktreeRefreshReleaseReason): DetectedWorktreeRefreshReleaseOutcome
}

export type DetectedWorktreeRefreshProviderInput =
  | Omit<LocalDetectedWorktreeRequest, 'providerRequestId'>
  | Omit<DirectSshDetectedWorktreeRequest, 'providerRequestId'>

export type DetectedWorktreeRefreshLeaseRegistryOptions = {
  startProviderRequest(
    request: ListDetectedWorktreesArgs
  ): Promise<HostQualifiedDetectedWorktreeResult>
  cancelProviderRequest(
    request: ListDetectedWorktreesArgs,
    reason: DetectedWorktreeRefreshReleaseReason
  ): void | Promise<void>
}

type LeaseWaiter = {
  settled: boolean
  resolve(result: HostQualifiedDetectedWorktreeResult): void
  reject(error: unknown): void
}

type ProviderInvocation = {
  publicKey: string
  request: ListDetectedWorktreesArgs
  waiters: Map<WaiterLeaseId, LeaseWaiter>
  settled: boolean
  cancelAttempted: boolean
}

export type DetectedWorktreeRefreshLeaseRegistry = {
  acquire(
    publicKey: string,
    input: DetectedWorktreeRefreshProviderInput
  ): DetectedWorktreeRefreshLease
  getActiveCounts(): { providerInvocations: number; waiterLeases: number }
}

let providerRequestSequence = 0
let waiterLeaseSequence = 0

function mintProviderRequestId(): ProviderRequestId {
  providerRequestSequence = nextIdentitySequence(providerRequestSequence)
  return `detected-worktree-provider-${providerRequestSequence}` as ProviderRequestId
}

function mintWaiterLeaseId(): WaiterLeaseId {
  waiterLeaseSequence = nextIdentitySequence(waiterLeaseSequence)
  return `detected-worktree-waiter-${waiterLeaseSequence}` as WaiterLeaseId
}

function nextIdentitySequence(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Detected worktree refresh identity sequence exhausted')
  }
  return current + 1
}

function requestsAreCompatible(
  request: ListDetectedWorktreesArgs,
  input: DetectedWorktreeRefreshProviderInput
): boolean {
  if (request.repoId !== input.repoId || request.executionHostId !== input.executionHostId) {
    return false
  }
  const requestAuthority = 'expectedAuthority' in request ? request.expectedAuthority : undefined
  const inputAuthority = 'expectedAuthority' in input ? input.expectedAuthority : undefined
  if (!requestAuthority || !inputAuthority) {
    return requestAuthority === inputAuthority
  }
  return (
    requestAuthority.targetId === inputAuthority.targetId &&
    requestAuthority.providerEpoch === inputAuthority.providerEpoch &&
    requestAuthority.connectionGeneration === inputAuthority.connectionGeneration
  )
}

function canceledResult(request: ListDetectedWorktreesArgs): HostQualifiedDetectedWorktreeResult {
  return {
    providerRequestId: request.providerRequestId,
    executionHostId: request.executionHostId,
    status: 'canceled'
  }
}

function providerRequestWithId(
  input: DetectedWorktreeRefreshProviderInput,
  providerRequestId: ProviderRequestId
): ListDetectedWorktreesArgs {
  if ('expectedAuthority' in input) {
    return {
      ...input,
      expectedAuthority: { ...input.expectedAuthority },
      providerRequestId
    }
  }
  return { ...input, providerRequestId }
}

export function createDetectedWorktreeRefreshLeaseRegistry(
  options: DetectedWorktreeRefreshLeaseRegistryOptions
): DetectedWorktreeRefreshLeaseRegistry {
  const invocationsByPublicKey = new Map<string, Set<ProviderInvocation>>()

  const removeInvocation = (invocation: ProviderInvocation): void => {
    const bucket = invocationsByPublicKey.get(invocation.publicKey)
    if (!bucket) {
      return
    }
    bucket.delete(invocation)
    if (bucket.size === 0) {
      invocationsByPublicKey.delete(invocation.publicKey)
    }
  }

  const settleProviderInvocation = (
    invocation: ProviderInvocation,
    settlement:
      | { status: 'fulfilled'; result: HostQualifiedDetectedWorktreeResult }
      | { status: 'rejected'; error: unknown }
  ): void => {
    if (invocation.settled) {
      return
    }
    invocation.settled = true
    removeInvocation(invocation)
    for (const waiter of invocation.waiters.values()) {
      if (waiter.settled) {
        continue
      }
      waiter.settled = true
      if (settlement.status === 'fulfilled') {
        waiter.resolve(settlement.result)
      } else {
        waiter.reject(settlement.error)
      }
    }
    invocation.waiters.clear()
  }

  const startInvocation = (
    publicKey: string,
    input: DetectedWorktreeRefreshProviderInput
  ): ProviderInvocation => {
    const request = providerRequestWithId(input, mintProviderRequestId())
    const invocation: ProviderInvocation = {
      publicKey,
      request,
      waiters: new Map(),
      settled: false,
      cancelAttempted: false
    }
    const bucket = invocationsByPublicKey.get(publicKey) ?? new Set()
    bucket.add(invocation)
    invocationsByPublicKey.set(publicKey, bucket)

    let result: Promise<HostQualifiedDetectedWorktreeResult>
    try {
      result = options.startProviderRequest(request)
    } catch (error) {
      result = Promise.reject(error)
    }
    void result.then(
      (providerResult) =>
        settleProviderInvocation(invocation, {
          status: 'fulfilled',
          result: providerResult
        }),
      (error) => settleProviderInvocation(invocation, { status: 'rejected', error })
    )
    return invocation
  }

  const acquire = (
    publicKey: string,
    input: DetectedWorktreeRefreshProviderInput
  ): DetectedWorktreeRefreshLease => {
    const invocation =
      [...(invocationsByPublicKey.get(publicKey) ?? [])].find(
        (candidate) =>
          !candidate.settled &&
          !candidate.cancelAttempted &&
          requestsAreCompatible(candidate.request, input)
      ) ?? startInvocation(publicKey, input)
    const waiterLeaseId = mintWaiterLeaseId()
    let resolveResult!: (result: HostQualifiedDetectedWorktreeResult) => void
    let rejectResult!: (error: unknown) => void
    const result = new Promise<HostQualifiedDetectedWorktreeResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const waiter: LeaseWaiter = {
      settled: false,
      resolve: resolveResult,
      reject: rejectResult
    }
    invocation.waiters.set(waiterLeaseId, waiter)

    return {
      waiterLeaseId,
      providerRequestId: invocation.request.providerRequestId,
      result,
      release: (reason) => {
        if (waiter.settled) {
          return 'already-settled'
        }
        waiter.settled = true
        invocation.waiters.delete(waiterLeaseId)
        waiter.resolve(canceledResult(invocation.request))
        if (invocation.settled || invocation.waiters.size > 0 || invocation.cancelAttempted) {
          return 'retained'
        }
        invocation.cancelAttempted = true
        let cancellation: void | Promise<void>
        try {
          cancellation = options.cancelProviderRequest(invocation.request, reason)
        } catch {
          return 'cancel-failed'
        }
        void Promise.resolve(cancellation).catch(() => undefined)
        return 'cancel-started'
      }
    }
  }

  return {
    acquire,
    getActiveCounts: () => {
      let providerInvocations = 0
      let waiterLeases = 0
      for (const bucket of invocationsByPublicKey.values()) {
        providerInvocations += bucket.size
        for (const invocation of bucket) {
          waiterLeases += invocation.waiters.size
        }
      }
      return { providerInvocations, waiterLeases }
    }
  }
}
