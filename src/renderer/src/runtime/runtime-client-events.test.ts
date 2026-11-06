import { describe, expect, it, vi } from 'vitest'

import { subscribeRuntimeClientEvents } from './runtime-client-events'
import {
  recordRuntimeSubscription,
  stubRuntimeEnvironmentBridge
} from './runtime-environment-bridge-fixture'

describe('subscribeRuntimeClientEvents', () => {
  it('rejects a partial runtime authority instead of retaining it', async () => {
    const { subscribe, respond } = recordRuntimeSubscription({ subscriptionId: 'sub-1' })
    const onEvent = vi.fn()
    const onError = vi.fn()
    stubRuntimeEnvironmentBridge({ subscribe })
    await subscribeRuntimeClientEvents('env-1', onEvent, onError)

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

    expect(onEvent).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }))
  })

  describe('when the server asks this desktop to host its browser pages', () => {
    async function ask(environment: Record<string, unknown>) {
      const { subscribe, respond } = recordRuntimeSubscription({ subscriptionId: 'sub-1' })
      const call = vi.fn().mockResolvedValue({ ok: true, result: { accepted: true } })
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
      await vi.waitFor(() => expect(call).toHaveBeenCalled())
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
