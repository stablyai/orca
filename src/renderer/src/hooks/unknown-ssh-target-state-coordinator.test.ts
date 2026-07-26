import { describe, expect, it, vi } from 'vitest'
import type { SshTargetSummary } from '../../../shared/ssh-types'
import {
  UnknownSshTargetStateCoordinator,
  UNKNOWN_SSH_TARGET_STATE_MAX_PENDING
} from './unknown-ssh-target-state-coordinator'

function deferredTargets(): {
  promise: Promise<SshTargetSummary[]>
  resolve: (targets: SshTargetSummary[]) => void
  reject: (error: unknown) => void
} {
  let resolve!: (targets: SshTargetSummary[]) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<SshTargetSummary[]>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function state(targetId: string, status: 'connecting' | 'error', error: string | null = null) {
  return { targetId, status, error, reconnectAttempt: status === 'error' ? 1 : 0 }
}

function setup(listTargets: () => Promise<SshTargetSummary[]>) {
  const dependencies = {
    listTargets: vi.fn(listTargets),
    setTargetsMetadata: vi.fn(),
    applyState: vi.fn(),
    clearRemovedTargetState: vi.fn()
  }
  return {
    dependencies,
    coordinator: new UnknownSshTargetStateCoordinator(dependencies)
  }
}

describe('unknown SSH target state coordinator', () => {
  it('keeps one target refresh in flight and applies only the latest state per target', async () => {
    const refresh = deferredTargets()
    const { coordinator, dependencies } = setup(() => refresh.promise)

    coordinator.enqueue('ssh-a', state('ssh-a', 'connecting'))
    coordinator.enqueue('ssh-a', state('ssh-a', 'error', 'failed'))
    coordinator.enqueue('ssh-removed', state('ssh-removed', 'error', 'gone'))
    expect(dependencies.listTargets).toHaveBeenCalledOnce()

    refresh.resolve([{ id: 'ssh-a', label: 'Remote A' }])
    await refresh.promise
    await vi.waitFor(() => {
      expect(dependencies.clearRemovedTargetState).toHaveBeenCalledWith('ssh-removed')
    })

    expect(dependencies.setTargetsMetadata).toHaveBeenCalledWith([
      { id: 'ssh-a', label: 'Remote A' }
    ])
    expect(dependencies.applyState).toHaveBeenCalledOnce()
    expect(dependencies.applyState).toHaveBeenCalledWith(
      'ssh-a',
      expect.objectContaining({ status: 'error', error: 'failed' })
    )
  })

  it('retries once and falls back to the latest state after both refreshes fail', async () => {
    const { coordinator, dependencies } = setup(() => Promise.reject(new Error('offline')))

    coordinator.enqueue('ssh-a', state('ssh-a', 'connecting'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(dependencies.listTargets).toHaveBeenCalledTimes(2)
    expect(dependencies.applyState).toHaveBeenCalledWith(
      'ssh-a',
      expect.objectContaining({ status: 'connecting' })
    )
  })

  it('rechecks a target first seen after an in-flight snapshot began', async () => {
    const first = deferredTargets()
    const second = deferredTargets()
    const { coordinator, dependencies } = setup(
      vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    )
    coordinator.enqueue('ssh-a', state('ssh-a', 'connecting'))
    coordinator.enqueue('ssh-b', state('ssh-b', 'connecting'))

    first.resolve([{ id: 'ssh-a', label: 'Remote A' }])
    await first.promise
    await Promise.resolve()

    expect(dependencies.applyState).toHaveBeenCalledWith(
      'ssh-a',
      expect.objectContaining({ status: 'connecting' })
    )
    expect(dependencies.clearRemovedTargetState).not.toHaveBeenCalledWith('ssh-b')
    expect(dependencies.listTargets).toHaveBeenCalledTimes(2)

    second.resolve([
      { id: 'ssh-a', label: 'Remote A' },
      { id: 'ssh-b', label: 'Remote B' }
    ])
    await second.promise
    await Promise.resolve()

    expect(dependencies.applyState).toHaveBeenCalledWith(
      'ssh-b',
      expect.objectContaining({ status: 'connecting' })
    )
  })

  it('caps pending state while a shared target refresh hangs', async () => {
    const refresh = deferredTargets()
    const { coordinator, dependencies } = setup(() => refresh.promise)
    for (let index = 0; index <= UNKNOWN_SSH_TARGET_STATE_MAX_PENDING; index += 1) {
      const targetId = `ssh-${index}`
      coordinator.enqueue(targetId, state(targetId, 'connecting'))
    }

    expect(coordinator.evidence()).toEqual({
      pending: UNKNOWN_SSH_TARGET_STATE_MAX_PENDING,
      refreshInFlight: true
    })
    expect(dependencies.listTargets).toHaveBeenCalledOnce()

    refresh.resolve(
      Array.from({ length: UNKNOWN_SSH_TARGET_STATE_MAX_PENDING + 1 }, (_, index) => ({
        id: `ssh-${index}`,
        label: `Remote ${index}`
      }))
    )
    await refresh.promise
    await vi.waitFor(() => {
      expect(dependencies.applyState).toHaveBeenCalledTimes(UNKNOWN_SSH_TARGET_STATE_MAX_PENDING)
    })
    expect(dependencies.applyState).not.toHaveBeenCalledWith('ssh-0', expect.anything())
  })

  it('drops malformed state without starting a refresh', () => {
    const { coordinator, dependencies } = setup(() => Promise.resolve([]))

    expect(coordinator.enqueue('ssh-a', { status: 'connected' })).toBe(false)
    expect(dependencies.listTargets).not.toHaveBeenCalled()
  })
})
