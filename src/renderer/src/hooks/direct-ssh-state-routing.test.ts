// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import {
  directSshAuthorityFromConnectionState,
  registerDirectSshWakeRouting,
  routeDirectSshConnectedState
} from './direct-ssh-state-routing'

function authority(epoch = 'epoch-a'): DirectSshAuthority {
  return {
    targetId: 'target-a',
    providerEpoch: epoch as SshProviderEpoch,
    connectionGeneration: 1
  }
}

function harness() {
  return {
    coordinatorRoutingEnabled: true,
    coordinator: {
      requestReconnect: vi.fn(async () => ({ status: 'complete' })),
      correctUnboundTerminals: vi.fn(() => 0),
      replaceAuthority: vi.fn()
    },
    invalidateStaleTerminalBindings: vi.fn(() => 0),
    retryTargetPanes: vi.fn(() => 0),
    prepareAndSync: vi.fn(),
    rememberReconnectAuthority: vi.fn()
  }
}

describe('routeDirectSshConnectedState', () => {
  it('keeps initial hydration preparation-only', () => {
    const deps = harness()
    const current = authority()

    expect(
      routeDirectSshConnectedState(deps, {
        authority: current,
        previousAuthority: null,
        origin: 'initial-hydration'
      })
    ).toBe('initial-hydration')
    expect(deps.prepareAndSync).toHaveBeenCalledWith(current, 'initial-hydration')
    expect(deps.coordinator.requestReconnect).not.toHaveBeenCalled()
    expect(deps.coordinator.correctUnboundTerminals).not.toHaveBeenCalled()
  })

  it('requests reconnect only when the complete pushed authority changes', () => {
    const deps = harness()
    const previous = authority('epoch-old')
    const current = authority('epoch-new')

    expect(
      routeDirectSshConnectedState(deps, {
        authority: current,
        previousAuthority: previous,
        origin: 'push'
      })
    ).toBe('changed-authority')
    expect(deps.rememberReconnectAuthority).toHaveBeenCalledWith(current)
    expect(deps.coordinator.requestReconnect).toHaveBeenCalledWith(current)
    expect(deps.coordinator.replaceAuthority).not.toHaveBeenCalled()
    expect(deps.prepareAndSync).not.toHaveBeenCalled()
  })

  it('runs the disabled fallback terminal actions synchronously before bounded preparation', () => {
    const order: string[] = []
    const deps = harness()
    deps.coordinatorRoutingEnabled = false
    deps.coordinator.replaceAuthority.mockImplementation(() => order.push('replace'))
    deps.invalidateStaleTerminalBindings.mockImplementation(() => {
      order.push('invalidate')
      return 1
    })
    deps.retryTargetPanes.mockImplementation(() => {
      order.push('retry')
      return 1
    })
    deps.prepareAndSync.mockImplementation(() => {
      order.push('prepare')
      return new Promise(() => {})
    })
    const previous = authority('epoch-old')
    const current = authority('epoch-new')

    expect(
      routeDirectSshConnectedState(deps, {
        authority: current,
        previousAuthority: previous,
        origin: 'push'
      })
    ).toBe('changed-authority-fallback')

    expect(order).toEqual(['replace', 'invalidate', 'retry', 'prepare'])
    expect(deps.coordinator.requestReconnect).not.toHaveBeenCalled()
    expect(deps.prepareAndSync).toHaveBeenCalledWith(current, 'reconnect', {
      authorityAlreadyReplaced: true
    })
    expect(deps.rememberReconnectAuthority).toHaveBeenCalledWith(current)
  })

  it('routes an exact-equal push through correction and fresh preparation', () => {
    const deps = harness()
    const current = authority()

    expect(
      routeDirectSshConnectedState(deps, {
        authority: current,
        previousAuthority: { ...current },
        origin: 'push'
      })
    ).toBe('same-authority-wake')
    expect(deps.coordinator.correctUnboundTerminals).toHaveBeenCalledWith(current, 'wake-refresh')
    expect(deps.prepareAndSync).toHaveBeenCalledWith(current, 'wake-refresh')
    expect(deps.coordinator.requestReconnect).not.toHaveBeenCalled()
  })
})

describe('registerDirectSshWakeRouting', () => {
  it('wakes only complete connected direct authorities and removes both listeners', () => {
    const wakeAuthority = vi.fn()
    let resume: (() => void) | undefined
    const unsubscribeSystemResumed = vi.fn()
    const stop = registerDirectSshWakeRouting({
      getConnectionStates: () =>
        new Map([
          [
            'target-a',
            {
              ...authority(),
              status: 'connected' as const,
              error: null,
              reconnectAttempt: 0
            }
          ],
          [
            'target-partial',
            {
              targetId: 'target-partial',
              status: 'connected' as const,
              error: null,
              reconnectAttempt: 0,
              providerEpoch: 'partial' as SshProviderEpoch
            }
          ],
          [
            'target-disconnected',
            {
              ...authority('disconnected'),
              targetId: 'target-disconnected',
              status: 'disconnected' as const,
              error: null,
              reconnectAttempt: 0
            }
          ]
        ]),
      wakeAuthority,
      onSystemResumed: (callback) => {
        resume = callback
        return unsubscribeSystemResumed
      }
    })

    window.dispatchEvent(new Event('online'))
    resume?.()

    expect(wakeAuthority).toHaveBeenCalledTimes(2)
    expect(wakeAuthority).toHaveBeenNthCalledWith(1, authority())
    expect(wakeAuthority).toHaveBeenNthCalledWith(2, authority())

    stop()
    stop()
    window.dispatchEvent(new Event('online'))
    resume?.()
    expect(unsubscribeSystemResumed).toHaveBeenCalledOnce()
    expect(wakeAuthority).toHaveBeenCalledTimes(2)
  })

  it('rejects mismatched keys and malformed partial authority', () => {
    expect(
      directSshAuthorityFromConnectionState('other-target', {
        ...authority(),
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
    ).toBeNull()
    expect(
      directSshAuthorityFromConnectionState('target-a', {
        targetId: 'target-a',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        connectionGeneration: 1
      })
    ).toBeNull()
  })
})
