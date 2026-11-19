// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorAccessRequest } from '../../../shared/connector-bot-access-contract'
import { makeAccessRequest } from '../../../shared/bots/bot-access-request.test-fixture'

const mocks = vi.hoisted(() => ({ toast: vi.fn(), call: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: mocks.toast, error: vi.fn() } }))
vi.mock('./bot-catalog', () => ({
  readBots: () => [{ id: 'bot-1', hostId: 'local', name: 'Scout' }],
  readBotsEnabled: () => true,
  refreshBotHost: vi.fn()
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import { emitBotsChangedWindowEvent } from './bots-changed-window-event'

/** A host whose list is `listed` (mutable); each read counts. */
function host(listed: ConnectorAccessRequest[]) {
  mocks.call.mockImplementation(async () => ({ ok: true, value: [...listed] }))
  const reads = (): number => mocks.call.mock.calls.length
  const changed = async (): Promise<void> => {
    const before = reads()
    emitBotsChangedWindowEvent('local')
    await vi.waitFor(() => expect(reads()).toBe(before + 1))
    // Let the read's reply land.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { reads, changed }
}

afterEach(() => {
  mocks.toast.mockReset()
  mocks.call.mockReset()
})

// A fresh module per test: what a window has seen lives for its lifetime.
async function freshWindow() {
  vi.resetModules()
  return (await import('./bot-access-requests')).watchAccessRequests
}

describe('the window’s access requests', () => {
  it('reads what waits without a toast, toasts each request once when it appears, and not on a re-read', async () => {
    const waiting = makeAccessRequest({ requestId: 'r1' })
    const asking = makeAccessRequest({
      requestId: 'r2',
      requester: { id: 'U2', name: 'Lee Park', handle: 'lee', detail: 'Lee Park' }
    })
    const listed = [waiting]
    const window = host(listed)
    const stop = (await freshWindow())()
    await vi.waitFor(() => expect(window.reads()).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 0))

    await window.changed()
    expect(mocks.toast).not.toHaveBeenCalled()
    listed.push(asking)
    await window.changed()
    await window.changed()

    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith(
      'Lee Park asked for access to Scout',
      expect.anything()
    )
    stop()
  })

  it('starts silent on the first answer, not on a failed read, and toasts after a signed-out one', async () => {
    const asking = makeAccessRequest({ requestId: 'r3' })
    const listed: ConnectorAccessRequest[] = []
    const window = host(listed)
    mocks.call.mockRejectedValueOnce(new Error('unreachable'))
    mocks.call.mockResolvedValueOnce({ ok: false, error: 'signed_out' })
    const stop = (await freshWindow())()
    await vi.waitFor(() => expect(window.reads()).toBe(1))

    await window.changed()
    listed.push(asking)
    await window.changed()

    expect(mocks.toast).toHaveBeenCalledOnce()
    stop()
  })
})
