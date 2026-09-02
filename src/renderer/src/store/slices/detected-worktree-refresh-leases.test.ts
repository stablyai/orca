import { describe, expect, it, vi } from 'vitest'
import type {
  HostQualifiedDetectedWorktreeResult,
  ListDetectedWorktreesArgs
} from '../../../../shared/detected-worktree-provider-contract'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../../shared/ssh-types'
import {
  createDetectedWorktreeRefreshLeaseRegistry,
  type DetectedWorktreeRefreshProviderInput
} from './detected-worktree-refresh-leases'

type ControlledPromise<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function controlledPromise<T>(): ControlledPromise<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function authority(providerEpoch: string, connectionGeneration = 1): DirectSshAuthority {
  return {
    targetId: 'ssh-a',
    providerEpoch: providerEpoch as SshProviderEpoch,
    connectionGeneration
  }
}

function directInput(
  expectedAuthority = authority('epoch-a')
): DetectedWorktreeRefreshProviderInput {
  return {
    repoId: 'repo-a',
    executionHostId: 'ssh:ssh-a',
    expectedAuthority
  }
}

function completeResult(request: ListDetectedWorktreesArgs): HostQualifiedDetectedWorktreeResult {
  if (!('expectedAuthority' in request)) {
    throw new Error('Expected direct SSH request')
  }
  return {
    status: 'complete',
    providerRequestId: request.providerRequestId,
    repoId: request.repoId,
    authority: {
      kind: 'direct-ssh',
      executionHostId: request.executionHostId,
      ...request.expectedAuthority
    },
    result: {
      repoId: request.repoId,
      authoritative: true,
      source: 'git',
      worktrees: []
    }
  }
}

function createHarness() {
  const pending: ControlledPromise<HostQualifiedDetectedWorktreeResult>[] = []
  const starts: ListDetectedWorktreesArgs[] = []
  const cancelProviderRequest = vi.fn()
  const registry = createDetectedWorktreeRefreshLeaseRegistry({
    startProviderRequest: (request) => {
      starts.push(request)
      const provider = controlledPromise<HostQualifiedDetectedWorktreeResult>()
      pending.push(provider)
      return provider.promise
    },
    cancelProviderRequest
  })
  return { cancelProviderRequest, pending, registry, starts }
}

describe('detected worktree refresh leases', () => {
  it('joins exact inputs with distinct waiter and shared provider identities', () => {
    const { registry, starts } = createHarness()

    const first = registry.acquire('repo-a:ssh:ssh-a', directInput())
    const second = registry.acquire('repo-a:ssh:ssh-a', directInput())

    expect(starts).toHaveLength(1)
    expect(first.providerRequestId).toBe(second.providerRequestId)
    expect(first.waiterLeaseId).not.toBe(second.waiterLeaseId)
    expect(first.waiterLeaseId).not.toBe(first.providerRequestId)
    expect(starts[0]).not.toHaveProperty('waiterLeaseId')
    expect(registry.getActiveCounts()).toEqual({
      providerInvocations: 1,
      waiterLeases: 2
    })
  })

  it('settles only the released waiter while another lease remains live', async () => {
    const { cancelProviderRequest, pending, registry, starts } = createHarness()
    const first = registry.acquire('repo-a:ssh:ssh-a', directInput())
    const second = registry.acquire('repo-a:ssh:ssh-a', directInput())

    expect(first.release('superseded')).toBe('retained')
    await expect(first.result).resolves.toEqual({
      providerRequestId: first.providerRequestId,
      executionHostId: 'ssh:ssh-a',
      status: 'canceled'
    })
    expect(cancelProviderRequest).not.toHaveBeenCalled()
    expect(registry.getActiveCounts()).toEqual({
      providerInvocations: 1,
      waiterLeases: 1
    })

    const providerResult = completeResult(starts[0])
    pending[0].resolve(providerResult)
    await expect(second.result).resolves.toEqual(providerResult)
    await expect(first.result).resolves.toMatchObject({ status: 'canceled' })
    expect(registry.getActiveCounts()).toEqual({
      providerInvocations: 0,
      waiterLeases: 0
    })
  })

  it('cancels once on last release and waits for local provider settlement', async () => {
    const { cancelProviderRequest, pending, registry, starts } = createHarness()
    const input = directInput()
    const lease = registry.acquire('repo-a:ssh:ssh-a', input)

    expect(lease.release('invalidated')).toBe('cancel-started')
    expect(lease.release('stopped')).toBe('already-settled')

    await expect(lease.result).resolves.toMatchObject({
      providerRequestId: lease.providerRequestId,
      status: 'canceled'
    })
    expect(cancelProviderRequest).toHaveBeenCalledTimes(1)
    expect(cancelProviderRequest).toHaveBeenCalledWith(starts[0], 'invalidated')
    expect(cancelProviderRequest.mock.calls[0]?.[0]).not.toHaveProperty('waiterLeaseId')
    expect(registry.getActiveCounts()).toEqual({
      providerInvocations: 1,
      waiterLeases: 0
    })

    pending[0].resolve(completeResult(starts[0]))
    await pending[0].promise
    await Promise.resolve()
    expect(registry.getActiveCounts()).toEqual({
      providerInvocations: 0,
      waiterLeases: 0
    })
  })

  it('reports no cancellation start when the invocation throws before send', async () => {
    const pending = controlledPromise<HostQualifiedDetectedWorktreeResult>()
    let sends = 0
    const invokeCancellation = vi.fn(() => {
      throw new Error('before send')
    })
    const startProviderRequest = vi.fn(() => pending.promise)
    const registry = createDetectedWorktreeRefreshLeaseRegistry({
      startProviderRequest,
      cancelProviderRequest: () => {
        invokeCancellation()
        sends++
      }
    })
    const lease = registry.acquire('repo-a:ssh:ssh-a', directInput())

    expect(lease.release('invalidated')).toBe('cancel-failed')
    expect(invokeCancellation).toHaveBeenCalledOnce()
    expect(sends).toBe(0)
    await expect(lease.result).resolves.toMatchObject({ status: 'canceled' })
    expect(registry.getActiveCounts()).toEqual({
      providerInvocations: 1,
      waiterLeases: 0
    })
    const replacement = registry.acquire('repo-a:ssh:ssh-a', directInput())
    expect(replacement.providerRequestId).not.toBe(lease.providerRequestId)
    expect(startProviderRequest).toHaveBeenCalledTimes(2)

    pending.resolve({
      providerRequestId: lease.providerRequestId,
      executionHostId: 'ssh:ssh-a',
      status: 'canceled'
    })
    await pending.promise
    await Promise.resolve()
    expect(registry.getActiveCounts()).toEqual({
      providerInvocations: 0,
      waiterLeases: 0
    })
  })

  it('keeps asynchronous cancellation fire-and-forget', async () => {
    const pending = controlledPromise<HostQualifiedDetectedWorktreeResult>()
    const registry = createDetectedWorktreeRefreshLeaseRegistry({
      startProviderRequest: () => pending.promise,
      cancelProviderRequest: () => Promise.reject(new Error('async cancellation failure'))
    })
    const lease = registry.acquire('repo-a:ssh:ssh-a', directInput())

    expect(lease.release('invalidated')).toBe('cancel-started')
    await expect(lease.result).resolves.toMatchObject({ status: 'canceled' })
    await Promise.resolve()

    pending.resolve({
      providerRequestId: lease.providerRequestId,
      executionHostId: 'ssh:ssh-a',
      status: 'canceled'
    })
    await pending.promise
    await Promise.resolve()
    expect(registry.getActiveCounts()).toEqual({
      providerInvocations: 0,
      waiterLeases: 0
    })
  })

  it('does not join incompatible full-authority inputs under one public key', () => {
    const { registry, starts } = createHarness()

    const first = registry.acquire('repo-a:ssh:ssh-a', directInput(authority('epoch-a', 1)))
    const second = registry.acquire('repo-a:ssh:ssh-a', directInput(authority('epoch-b', 1)))
    const third = registry.acquire('repo-a:ssh:ssh-a', directInput(authority('epoch-a', 2)))

    expect(starts).toHaveLength(3)
    expect(
      new Set([first.providerRequestId, second.providerRequestId, third.providerRequestId]).size
    ).toBe(3)
    expect(registry.getActiveCounts()).toEqual({
      providerInvocations: 3,
      waiterLeases: 3
    })
  })

  it('removes settled invocations so a later acquire starts fresh', async () => {
    const { pending, registry, starts } = createHarness()
    const first = registry.acquire('repo-a:ssh:ssh-a', directInput())

    const firstResult = completeResult(starts[0])
    pending[0].resolve(firstResult)
    await expect(first.result).resolves.toEqual(firstResult)
    expect(registry.getActiveCounts()).toEqual({
      providerInvocations: 0,
      waiterLeases: 0
    })

    const second = registry.acquire('repo-a:ssh:ssh-a', directInput())
    expect(starts).toHaveLength(2)
    expect(second.providerRequestId).not.toBe(first.providerRequestId)
    expect(second.waiterLeaseId).not.toBe(first.waiterLeaseId)
  })

  it('cleans rejected provider invocations without retaining waiters', async () => {
    const { pending, registry } = createHarness()
    const lease = registry.acquire('repo-a:ssh:ssh-a', directInput())
    const error = new Error('provider failed')

    pending[0].reject(error)
    await expect(lease.result).rejects.toBe(error)
    expect(registry.getActiveCounts()).toEqual({
      providerInvocations: 0,
      waiterLeases: 0
    })
  })
})
