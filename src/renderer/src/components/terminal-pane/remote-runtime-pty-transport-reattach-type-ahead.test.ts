import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// These transport fixtures never read abandoned-launch ownership from the app store.
const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

import {
  TerminalStreamOpcode,
  decodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

const ORIGINAL_ID = 'remote:env-1@@terminal-1'

let callbacks: MultiplexSubscriptionCallbacks = null
let resolvedHandle = 'terminal-1'
const {
  runtimeCall,
  runtimeSubscribe,
  latestFrameForOpcode,
  latestSubscribePayload,
  emitSnapshot,
  inputFrameTexts,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => callbacks,
  setCallbacks: (value) => {
    callbacks = value
  },
  getResolvedPaneHandle: () => resolvedHandle,
  setResolvedPaneHandle: (value) => {
    resolvedHandle = value
  }
})

beforeEach(resetRemoteRuntimeTransport)

/** Real hosts publish `subscribed` and the initial snapshot that completes the attach. */
async function completeAttach(): Promise<void> {
  await vi.waitFor(() => expect(latestSubscribePayload()).toBeDefined())
  const { streamId } = latestSubscribePayload()
  callbacks?.onResponse({ ok: true, result: { type: 'subscribed', streamId } })
  emitSnapshot(streamId, 'prompt$ ')
}

/** Holds `terminal.create` open until the spec settles it with the handle the host returns. */
async function createGatedTransport() {
  const created = createDeferred<string | Error>()
  // Acknowledged writes to a host without input acks go out as `terminal.send` calls.
  const acceptedSends: string[] = []
  const call = runtimeCall.getMockImplementation()
  runtimeCall.mockImplementation(
    async (request: { method: string; params?: { text?: string } }) => {
      if (request.method === 'terminal.send') {
        acceptedSends.push(request.params?.text ?? '')
        return { ok: true, result: { send: { accepted: true } } }
      }
      if (request.method !== 'terminal.create') {
        return call?.(request)
      }
      const outcome = await created.promise
      if (outcome instanceof Error) {
        throw outcome
      }
      return { ok: true, result: { terminal: { handle: outcome, isReattach: true } } }
    }
  )
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })
  const waitForCreate = () =>
    vi.waitFor(() => {
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.create' })
      )
    })
  return { transport, created, waitForCreate, acceptedSends }
}

describe('remote reattach type-ahead', () => {
  it('sends typing from a restored screen after the host finishes resolving its original pane', async () => {
    const resolution = createDeferred<void>()
    const call = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'terminal.resolvePane') {
        await resolution.promise
      }
      return call?.(request)
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })
    try {
      expect(transport.sendInput('probe-', 'driving')).toBe(true)
      const connecting = transport.connect({ url: '', sessionId: ORIGINAL_ID, callbacks: {} })
      await vi.waitFor(() => {
        expect(runtimeCall).toHaveBeenCalledWith(
          expect.objectContaining({ method: 'terminal.resolvePane' })
        )
      })
      expect(transport.getPtyId()).toBeNull()
      expect(transport.sendInput('cold-parked\r', 'driving')).toBe(true)
      expect(latestFrameForOpcode(TerminalStreamOpcode.Input)).toBeUndefined()
      resolution.resolve()
      await connecting
      await completeAttach()
      await vi.waitFor(() => {
        const frame = latestFrameForOpcode(TerminalStreamOpcode.Input)
        expect(frame && decodeTerminalStreamText(frame.payload)).toBe('probe-cold-parked\r')
      })
    } finally {
      resolution.resolve()
      transport.destroy?.()
    }
  })

  it('delivers typing and an acknowledged interrupt from before and during the reattach', async () => {
    const { transport, created, waitForCreate, acceptedSends } = await createGatedTransport()
    expect(transport.sendInput('before', 'driving')).toBe(true)
    const accepted = transport.sendInputAccepted?.('\x03', 'driving')
    const connecting = transport.connect({ url: '', sessionId: ORIGINAL_ID, callbacks: {} })
    await waitForCreate()
    expect(transport.sendInput('after\r', 'driving')).toBe(true)
    expect(inputFrameTexts()).toEqual([])
    created.resolve('terminal-1')
    await connecting
    await completeAttach()
    await expect(accepted).resolves.toBe(true)
    // The interrupt carries the typing queued ahead of it, so order holds across both paths.
    expect(acceptedSends).toEqual(['before\x03'])
    await vi.waitFor(() => expect(inputFrameTexts()).toEqual(['after\r']))
    transport.destroy?.()
  })

  it.each([undefined, 'remote:env-2@@terminal-1', 'remote:terminal-1'])(
    'discards pre-entry typing when the first connect does not restore this pane: %s',
    async (sessionId) => {
      const { transport, created, waitForCreate } = await createGatedTransport()
      const accepted = transport.sendInputAccepted?.('old tail\r', 'driving')
      const connecting = transport.connect({ url: '', sessionId, callbacks: {} })
      await expect(accepted).resolves.toBe(false)
      await waitForCreate()
      created.resolve('terminal-1')
      await connecting
      await flushAsyncTicks()
      expect(inputFrameTexts()).toEqual([])
      transport.destroy?.()
    }
  )

  it.each(['terminal-replacement', new Error('offline')])(
    'never forwards retained input when the original terminal is unavailable: %s',
    async (outcome) => {
      const { transport, created, waitForCreate } = await createGatedTransport()
      const connecting = transport.connect({ url: '', sessionId: ORIGINAL_ID, callbacks: {} })
      await waitForCreate()
      const accepted = transport.sendInputAccepted?.('dangerous tail\r', 'driving')
      expect(transport.sendInput('\x1b[I', 'query-reply')).toBe(false)
      expect(transport.sendInputImmediate('\x1b[1;1R')).toBe(false)
      created.resolve(outcome)
      await connecting
      if (typeof outcome === 'string') {
        await completeAttach()
      }
      await expect(accepted).resolves.toBe(false)
      await flushAsyncTicks()
      expect(inputFrameTexts()).toEqual([])
      transport.destroy?.()
    }
  )

  it.each([
    ['terminal-1', 'tail-on-old-pixels\r'],
    ['terminal-replacement', '']
  ])(
    'keeps typing between binding %s and its first snapshot scoped to the restored terminal',
    async (boundHandle, delivered) => {
      const subscribed = createDeferred<void>()
      const subscribe = runtimeSubscribe.getMockImplementation()
      runtimeSubscribe.mockImplementation(async (...args: unknown[]) => {
        await subscribed.promise
        return subscribe?.(...args)
      })
      const { transport, created, waitForCreate } = await createGatedTransport()
      const connecting = transport.connect({ url: '', sessionId: ORIGINAL_ID, callbacks: {} })
      await waitForCreate()
      created.resolve(boundHandle)
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalled())
      expect(transport.sendInput('tail-on-old-pixels\r', 'driving')).toBe(true)
      subscribed.resolve()
      await connecting
      await completeAttach()
      // A key typed on the new snapshot proves everything held ahead of it has settled.
      expect(transport.sendInput('on-new-snapshot', 'driving')).toBe(true)
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toMatch(/on-new-snapshot$/))
      expect(inputFrameTexts().join('')).toBe(`${delivered}on-new-snapshot`)
      transport.destroy?.()
    }
  )

  it.each(['attach', 'disconnect', 'detach', 'destroy'] as const)(
    'drops input and settles accepted writes on %s before a late reattach',
    async (action) => {
      const { transport, created, waitForCreate } = await createGatedTransport()
      const preEntry = transport.sendInputAccepted?.('pre-entry\r', 'driving')
      if (action === 'attach') {
        transport.attach({ existingPtyId: ORIGINAL_ID, callbacks: {} })
        await expect(preEntry).resolves.toBe(false)
        transport.destroy?.()
        return
      }
      const connecting = transport.connect({ url: '', sessionId: ORIGINAL_ID, callbacks: {} })
      await waitForCreate()
      const accepted = transport.sendInputAccepted?.('stale\r', 'driving')
      transport[action]?.()
      await expect(preEntry).resolves.toBe(false)
      await expect(accepted).resolves.toBe(false)
      created.resolve('terminal-1')
      await connecting
      await flushAsyncTicks()
      expect(inputFrameTexts()).toEqual([])
      transport.destroy?.()
    }
  )
})
