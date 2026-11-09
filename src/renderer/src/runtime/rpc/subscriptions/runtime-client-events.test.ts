import { describe, expect, it, vi } from 'vitest'

import { subscribeRuntimeClientEvents } from './runtime-client-events'
import {
  recordRuntimeSubscription,
  stubRuntimeEnvironmentBridge
} from '../testing/runtime-environment-bridge-fixture'

describe('subscribeRuntimeClientEvents', () => {
  it('rejects a partial runtime authority instead of retaining it', async () => {
    const { subscribe, respond } = recordRuntimeSubscription({ subscriptionId: 'sub-1' })
    const observed: string[] = []
    stubRuntimeEnvironmentBridge({ subscribe })
    await subscribeRuntimeClientEvents(
      'env-1',
      () => observed.push('event'),
      () => observed.push('error')
    )

    respond({
      ok: true,
      result: {
        type: 'sshStateChanged',
        targetId: 'ssh-1',
        state: {
          targetId: 'ssh-1',
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          providerEpoch: 'partial-provider-epoch'
        }
      }
    })

    expect(observed).toEqual(['error'])
  })

  describe('when the server asks this desktop to host its browser pages', () => {
    async function ask(environment: Record<string, unknown>) {
      const { subscribe, respond } = recordRuntimeSubscription({ subscriptionId: 'sub-1' })
      const answered = Promise.withResolvers<void>()
      const call = vi.fn(async () => {
        answered.resolve()
        return { ok: true, result: { accepted: true } }
      })
      const prepareBrowserClientHostPlacement = vi
        .fn()
        .mockResolvedValue({ kind: 'client', browserHostClientId: 'host-a' })
      stubRuntimeEnvironmentBridge({
        subscribe,
        call,
        prepareBrowserClientHostPlacement,
        list: vi.fn().mockResolvedValue([{ id: 'env-1', ...environment }])
      })
      await subscribeRuntimeClientEvents('env-1', vi.fn(), undefined, undefined, {
        hostsBrowserPages: true
      })
      expect(subscribe.mock.calls[0]?.[0]).toMatchObject({ params: { browserHostRequests: true } })
      respond({ ok: true, result: { type: 'browserHostRequested', requestId: 'request-1' } })
      await answered.promise
      return { call, prepareBrowserClientHostPlacement }
    }

    it('starts hosting and names the lease it now holds', async () => {
      const { call, prepareBrowserClientHostPlacement } = await ask({})

      expect(prepareBrowserClientHostPlacement).toHaveBeenCalledWith(
        expect.objectContaining({ selector: 'env-1', preference: 'auto' })
      )
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'browser.clientHost.requestResult',
          params: { requestId: 'request-1', browserHostClientId: 'host-a' }
        })
      )
    })

    // Managed SSH hosts use the desktop browser bridge, so their open-url must not land here.
    it('declines for a host that became managed over SSH without starting a lease', async () => {
      const { call, prepareBrowserClientHostPlacement } = await ask({
        orcadDeployment: { sshTargetId: 'target-1' }
      })

      expect(prepareBrowserClientHostPlacement).not.toHaveBeenCalled()
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({ params: { requestId: 'request-1' } })
      )
    })
  })
})
