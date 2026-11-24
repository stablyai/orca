import { expect, it, vi } from 'vitest'
import { RemoteBrowserInputQueue } from './remote-browser-input-queue'

// Waits end only when their call is aborted; the host refuses a cancel from a retired request.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (
    _target: unknown,
    method: string,
    _params: Record<string, unknown>,
    options: { signal?: AbortSignal }
  ) => {
    if (method === 'browser.grab.await') {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true
        })
      })
    }
    return Promise.resolve(method === 'browser.grab.cancel' ? { cancelled: false } : null)
  }
}))

const { createRemoteBrowserGuestToolsTransport } =
  await import('./remote-browser-guest-tools-transport')

function transport() {
  return createRemoteBrowserGuestToolsTransport({
    target: () => ({ kind: 'environment', environmentId: 'env-1' }),
    worktree: 'wt',
    remotePage: () => 'page',
    inputQueue: new RemoteBrowserInputQueue()
  })
}

it("a retired request's cancel leaves the wait of the request that replaced it running", async () => {
  const tools = transport()
  let settled = false
  const current = tools
    .awaitGrabSelection({ browserPageId: 'page', opId: 'op-b', requestId: 'request-b' })
    .finally(() => {
      settled = true
    })
  await expect(tools.cancelGrab({ browserPageId: 'page', requestId: 'request-a' })).resolves.toBe(
    false
  )
  await Promise.resolve()
  expect(settled).toBe(false)

  await tools.cancelGrab({ browserPageId: 'page', requestId: 'request-b' })
  await expect(current).resolves.toEqual({ opId: 'op-b', kind: 'cancelled', reason: 'user' })
})

it('a cancel without a request still ends every wait', async () => {
  const tools = transport()
  const first = tools.awaitGrabSelection({ browserPageId: 'page', opId: 'op-a', requestId: 'a' })
  const second = tools.awaitGrabSelection({ browserPageId: 'page', opId: 'op-b' })
  await tools.cancelGrab({ browserPageId: 'page' })
  await expect(first).resolves.toMatchObject({ kind: 'cancelled' })
  await expect(second).resolves.toMatchObject({ kind: 'cancelled' })
})
