import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserClientAutomationMethod } from '../browser-client-automation-protocol'
import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import type { RuntimeRpcResponse } from '../runtime-rpc-envelope'
import type {
  BrowserHostLeaseSubscriptionCallbacks,
  SubscribeBrowserHostLease
} from './browser-host-lease-subscription'
import { PairedRuntimeBrowserClientHost } from './paired-runtime-browser-client-host'

const identity = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'phone-a',
  browserHostGeneration: 1
}

function response(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'attach', ok: true, result, _meta: { runtimeId: 'runtime-a' } }
}

function ready(supportedAutomationMethods?: readonly BrowserClientAutomationMethod[]) {
  return response({
    type: 'ready',
    authorityEpoch: identity.authorityEpoch,
    browserHostGeneration: 1,
    pageCommandProtocolVersion: 1,
    pageInventoryProtocolVersion: 1,
    leaseReconnectProtocolVersion: 1,
    supportedAutomationMethods
  })
}

function command(commandId = 'create-a', commandSequence = 1) {
  return response({
    ...identity,
    type: 'command',
    pageCommandProtocolVersion: 1,
    browserPageId: 'page-a',
    pageHostGeneration: 1,
    commandId,
    commandSequence,
    command: {
      type: 'createPage',
      browserProfileId: 'profile-a',
      executionHostKey: 'ssh:host-a',
      workspaceId: 'folder:workspace-a'
    }
  })
}

function adapter() {
  const attempts: {
    callbacks: BrowserHostLeaseSubscriptionCallbacks
    close: ReturnType<typeof vi.fn>
    sendRequest: ReturnType<typeof vi.fn>
  }[] = []
  const subscribe = vi.fn<SubscribeBrowserHostLease>(async (_params, _timeout, callbacks) => {
    const attempt = {
      callbacks,
      close: vi.fn(),
      sendRequest: vi.fn(async () => response({ accepted: true }))
    }
    attempts.push(attempt)
    return attempt
  })
  return { attempts, subscribe }
}

describe('portable browser host lease', () => {
  it.each([undefined, ['browser.snapshot'] as const])(
    'preserves method negotiation %j and installs the sender before authority callbacks',
    async (supportedAutomationMethods) => {
      const { attempts, subscribe } = adapter()
      const host = new PairedRuntimeBrowserClientHost({
        ...identity,
        subscribe,
        supportedAutomationMethods,
        hostCapabilities: ['webview', 'automation-v1'],
        getPageInventory: () => [],
        handler: () => ({ status: 'completed' }),
        onAuthority: () => {
          void host.sendPageMetadataRequest({ url: 'https://example.test/' }, 100)
        }
      })
      const starting = host.start()
      await vi.waitFor(() => expect(attempts).toHaveLength(1))
      attempts[0].callbacks.onResponse(ready(supportedAutomationMethods))
      expect((await starting).supportedAutomationMethods).toEqual(supportedAutomationMethods)
      const params = subscribe.mock.calls[0][0]
      expect(params.supportedAutomationMethods).toEqual(supportedAutomationMethods)
      if (supportedAutomationMethods === undefined) {
        expect(JSON.stringify(params)).not.toContain('supportedAutomationMethods')
      }
      expect(attempts[0].sendRequest).toHaveBeenCalledWith(
        'browser.clientHost.pageMetadata',
        { url: 'https://example.test/' },
        100
      )
      await host.close()
    }
  )

  it('fails closed if an adapter delivers readiness before its sender is installed', async () => {
    const close = vi.fn()
    const onAuthority = vi.fn()
    const sendRequest = vi.fn(async () => response({ accepted: true }))
    const host = new PairedRuntimeBrowserClientHost({
      ...identity,
      subscribe: async (_params, _timeout, callbacks) => {
        callbacks.onResponse(ready())
        return { close, sendRequest }
      },
      hostCapabilities: ['webview'],
      getPageInventory: () => [],
      onAuthority,
      handler: () => ({ status: 'completed' })
    })
    await expect(host.start()).rejects.toThrow('command result transport unavailable')
    expect(onAuthority).not.toHaveBeenCalled()
    expect(sendRequest).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    await host.close()
  })

  it('retains the dispatcher across reconnect and refuses replaced connection callbacks', async () => {
    const { attempts, subscribe } = adapter()
    const handler = vi.fn(() => ({ status: 'completed' as const }))
    const onError = vi.fn()
    const onReconnected = vi.fn()
    const host = new PairedRuntimeBrowserClientHost({
      ...identity,
      subscribe,
      hostCapabilities: ['webview'],
      getPageInventory: () => [],
      reconnectRetryDelayMs: 1,
      handler,
      onError,
      onReconnected
    })
    const starting = host.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    attempts[0].callbacks.onResponse(ready())
    await starting
    attempts[0].callbacks.onResponse(command())
    await vi.waitFor(() => expect(attempts[0].sendRequest).toHaveBeenCalledOnce())
    attempts[0].callbacks.onClose()
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    attempts[1].callbacks.onResponse(ready())
    attempts[0].callbacks.onResponse(command('stale-command', 2))
    attempts[0].callbacks.onError(new RemoteRuntimeClientError('unauthorized', 'stale error'))
    attempts[0].callbacks.onClose()
    attempts[1].callbacks.onResponse(command())
    await vi.waitFor(() => expect(attempts[1].sendRequest).toHaveBeenCalledOnce())
    expect(attempts[0].sendRequest).toHaveBeenCalledOnce()
    expect(attempts[1].sendRequest.mock.calls[0]).toEqual(attempts[0].sendRequest.mock.calls[0])
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          executionHostKey: 'ssh:host-a',
          workspaceId: 'folder:workspace-a'
        })
      }),
      expect.any(AbortSignal)
    )
    expect(onReconnected).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    await host.close()
  })

  it('bundles and executes the receiver without Node globals', async () => {
    const bundle = await build({
      entryPoints: ['src/shared/browser-client-host/paired-runtime-browser-client-host.ts'],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'BrowserReceiver',
      write: false,
      metafile: true
    })
    expect(Object.keys(bundle.metafile.inputs).some((file) => file.startsWith('src/main/'))).toBe(
      false
    )
    expect(Object.values(bundle.metafile.outputs).flatMap((output) => output.imports)).toEqual([])
    let timerId = 0
    const timers = new Map<number, ReturnType<typeof setTimeout>>()
    const browserSetTimeout = (callback: () => void, delay: number): number => {
      const id = ++timerId
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id)
          callback()
        }, delay)
      )
      return id
    }
    const browserClearTimeout = (id: number): void => {
      clearTimeout(timers.get(id))
      timers.delete(id)
    }
    const result: unknown = await runInNewContext(
      `${bundle.outputFiles[0].text}
      (async () => {
        if (typeof Buffer !== 'undefined' || typeof process !== 'undefined' ||
            typeof require !== 'undefined' || typeof structuredClone !== 'undefined') {
          throw new Error('Unexpected runtime global')
        }
        let callbacks;
        let handled = 0;
        let sent = 0;
        let resolveResult;
        const resultSent = new Promise(resolve => { resolveResult = resolve });
        const host = new BrowserReceiver.PairedRuntimeBrowserClientHost({
          authorityRuntimeId: 'runtime-a', browserHostClientId: 'phone-a',
          hostCapabilities: ['webview'], getPageInventory: () => [],
          subscribe: async (_params, _timeout, cb) => {
            callbacks = cb;
            return { close() {}, sendRequest: async () => {
              sent++; resolveResult();
              return ${JSON.stringify(response({ accepted: true }))};
            } };
          },
          handler: () => { handled++; return { status: 'completed' }; }
        });
        const starting = host.start();
        await Promise.resolve();
        callbacks.onResponse(${JSON.stringify(ready())});
        await starting;
        callbacks.onResponse(${JSON.stringify(command())});
        await resultSent;
        await host.close();
        return { handled, sent };
      })()`,
      {
        TextEncoder,
        AbortController,
        setTimeout: browserSetTimeout,
        clearTimeout: browserClearTimeout
      }
    )
    expect(result).toEqual({ handled: 1, sent: 1 })
    expect(timers.size).toBe(0)
  })
})
