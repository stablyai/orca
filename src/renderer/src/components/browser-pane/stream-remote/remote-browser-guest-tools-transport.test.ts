import { expect, it, vi } from 'vitest'
import { RemoteBrowserInputQueue } from './remote-browser-input-queue'

const sent = vi.hoisted((): string[] => [])
const sentEnables = vi.hoisted((): unknown[] => [])
const sentPages = vi.hoisted((): string[] => [])

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
    sentPages.push(`${method}@${String(params.page)}`)
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

function transport(inputQueue = new RemoteBrowserInputQueue(), remotePage = () => 'page') {
  return createRemoteBrowserGuestToolsTransport({
    target: () => ({ kind: 'environment', environmentId: 'env-1' }),
    worktree: 'wt',
    remotePage,
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
  const cancel = tools.cancelGrab({ browserPageId: 'page', requestId: 'waits-for-page' })
  await Promise.resolve()
  // Sent at once: queued behind the held enable, the cancel would never leave.
  expect(sent).toContain('browser.grab.cancel')
  await expect(cancel).resolves.toBe(false)
})

it('a cancel without a request still ends every wait', async () => {
  const tools = transport()
  const first = tools.awaitGrabSelection({ browserPageId: 'page', opId: 'op-a', requestId: 'a' })
  const second = tools.awaitGrabSelection({ browserPageId: 'page', opId: 'op-b' })
  await tools.cancelGrab({ browserPageId: 'page' })
  await expect(first).resolves.toMatchObject({ kind: 'cancelled' })
  await expect(second).resolves.toMatchObject({ kind: 'cancelled' })
})

it('a request waits and cancels on the page it armed, even after the streamed page changes', async () => {
  let page = 'page-1'
  const tools = transport(new RemoteBrowserInputQueue(), () => page)
  await tools.setGrabMode({ browserPageId: 'tab', enabled: true, requestId: 'r' })
  page = 'page-2'
  sentPages.length = 0
  const wait = tools.awaitGrabSelection({ browserPageId: 'tab', opId: 'op', requestId: 'r' })
  await tools.cancelGrab({ browserPageId: 'tab', requestId: 'r' })
  await wait
  expect(sentPages).toEqual(['browser.grab.await@page-1', 'browser.grab.cancel@page-1'])
  sentPages.length = 0
  await tools.cancelGrab({ browserPageId: 'tab' })
  expect(sentPages).toEqual(['browser.grab.cancel@page-2'])
})

it('a cancel that overtakes its delayed enable, and its retry, both reach the page it armed on', async () => {
  const inputQueue = new RemoteBrowserInputQueue()
  let page = 'page-1'
  const tools = transport(inputQueue, () => page)
  let releaseEarlierInput: () => void = () => {}
  void inputQueue.enqueue(
    () =>
      new Promise<void>((resolve) => {
        releaseEarlierInput = resolve
      })
  )
  const enable = tools.setGrabMode({ browserPageId: 'tab', enabled: true, requestId: 'r' })
  page = 'page-2'
  sentPages.length = 0
  await tools.cancelGrab({ browserPageId: 'tab', requestId: 'r' })
  releaseEarlierInput()
  await enable
  // The picker's retry once the superseded enable settles.
  await tools.cancelGrab({ browserPageId: 'tab', requestId: 'r' })
  expect(sentPages).toEqual(['browser.grab.cancel@page-1', 'browser.grab.cancel@page-1'])
})
