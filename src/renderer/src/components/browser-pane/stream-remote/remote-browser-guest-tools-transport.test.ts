import { expect, it, vi } from 'vitest'
import { RemoteBrowserInputQueue } from './remote-browser-input-queue'

const sent = vi.hoisted((): string[] => [])

// Waits end only when their call is aborted; the host refuses a cancel from a retired request; an
// enable for 'waits-for-page' stays pending, like one held until its remote page loads.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (
    _target: unknown,
    method: string,
    params: Record<string, unknown>,
    options: { signal?: AbortSignal }
  ) => {
    sent.push(method)
    if (method === 'browser.grab.setMode' && params.requestId === 'waits-for-page') {
      return new Promise(() => {})
    }
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

it('a cancel reaches the host while an earlier enable still waits for its page', async () => {
  const tools = transport()
  void tools.setGrabMode({ browserPageId: 'page', enabled: true, requestId: 'waits-for-page' })
  await Promise.resolve()
  sent.length = 0
  await expect(
    tools.cancelGrab({ browserPageId: 'page', requestId: 'waits-for-page' })
  ).resolves.toBe(false)
  // Before the fix the cancel sat behind the enable in the input queue and never left.
  expect(sent).toContain('browser.grab.cancel')
})

it('a cancel without a request still ends every wait', async () => {
  const tools = transport()
  const first = tools.awaitGrabSelection({ browserPageId: 'page', opId: 'op-a', requestId: 'a' })
  const second = tools.awaitGrabSelection({ browserPageId: 'page', opId: 'op-b' })
  await tools.cancelGrab({ browserPageId: 'page' })
  await expect(first).resolves.toMatchObject({ kind: 'cancelled' })
  await expect(second).resolves.toMatchObject({ kind: 'cancelled' })
})
