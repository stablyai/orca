import { expect, it, vi } from 'vitest'
import { RemoteBrowserInputQueue } from './remote-browser-input-queue'

const sent = vi.hoisted((): string[] => [])
const sentEnables = vi.hoisted((): unknown[] => [])

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
    if (method === 'browser.grab.setMode') {
      sentEnables.push(params.requestId)
      if (params.requestId === 'waits-for-page') {
        return new Promise(() => {})
      }
      return Promise.resolve({ ok: true, clean: false })
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

function transport(inputQueue = new RemoteBrowserInputQueue()) {
  return createRemoteBrowserGuestToolsTransport({
    target: () => ({ kind: 'environment', environmentId: 'env-1' }),
    worktree: 'wt',
    remotePage: () => 'page',
    inputQueue
  })
}

it('a cancelled enable still queued behind earlier input never sends; the next enable works', async () => {
  const inputQueue = new RemoteBrowserInputQueue()
  const tools = transport(inputQueue)
  let releaseEarlierInput: () => void = () => {}
  void inputQueue.enqueue(
    () =>
      new Promise<void>((resolve) => {
        releaseEarlierInput = resolve
      })
  )
  sentEnables.length = 0
  const enableA = tools.setGrabMode({ browserPageId: 'page', enabled: true, requestId: 'a' })
  await expect(tools.cancelGrab({ browserPageId: 'page', requestId: 'a' })).resolves.toBe(true)
  const enableB = tools.setGrabMode({ browserPageId: 'page', enabled: true, requestId: 'b' })
  releaseEarlierInput()
  await expect(enableA).resolves.toEqual({ ok: false, reason: 'not-ready' })
  await expect(enableB).resolves.toEqual({ ok: true, clean: false })
  expect(sentEnables).toEqual(['b'])
})

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
  sentEnables.length = 0
  void tools.setGrabMode({ browserPageId: 'page', enabled: true, requestId: 'waits-for-page' })
  // The enable has reached the host, which holds it until the page loads.
  await vi.waitFor(() => expect(sentEnables).toEqual(['waits-for-page']))
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
