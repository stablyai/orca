import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

import {
  TerminalStreamOpcode,
  decodeTerminalStreamText
} from '../../../../../../shared/terminal/stream/terminal-stream-protocol'
import { createDeferred } from '../../pty-connection/test-fixtures/pty-connection-test-async'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'

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
type CreatedTerminal = {
  handle: string
  isReattach?: true
  coldRestore?: { scrollback: string; cwd: string }
}

async function createGatedTransport(options: Record<string, unknown> = {}) {
  const created = createDeferred<string | Error | CreatedTerminal>()
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
      // A bare handle stands for the host adopting this pane's existing terminal.
      const terminal = typeof outcome === 'string' ? { handle: outcome, isReattach: true } : outcome
      return { ok: true, result: { terminal } }
    }
  )
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1', ...options })
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

  describe('a brand-new pane', () => {
    // Why: the host adopts a live terminal for this tab and leaf, or restores history into a new
    // one; typing made for a blank pane must not run in either (#10065).
    it.each([
      ['an adopted terminal', { handle: 'terminal-live', isReattach: true as const }],
      [
        'a cold-restored terminal',
        { handle: 'terminal-restored', coldRestore: { scrollback: 'old$ ', cwd: '/w' } }
      ]
    ])('drops its typing when the first create returns %s', async (_label, terminal) => {
      const { transport, created, waitForCreate } = await createGatedTransport({
        keepTypeAheadForNewTerminal: () => true
      })
      expect(transport.sendInput('rm -rf build\r', 'driving')).toBe(true)
      const connecting = transport.connect({ url: '', callbacks: {} })
      await waitForCreate()
      created.resolve(terminal)
      await connecting
      await completeAttach()
      expect(transport.sendInput('live', 'driving')).toBe(true)
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toMatch(/live$/))
      expect(inputFrameTexts().join('')).toBe('live')
      transport.destroy?.()
    })

    it('drops typing held across a failed first create when a later connect creates', async () => {
      const { transport, created, waitForCreate } = await createGatedTransport({
        keepTypeAheadForNewTerminal: () => true
      })
      expect(transport.sendInput('first try\r', 'driving')).toBe(true)
      const first = transport.connect({ url: '', callbacks: {} })
      await waitForCreate()
      created.resolve(new Error('offline'))
      await first
      const call = runtimeCall.getMockImplementation()
      runtimeCall.mockImplementation(async (request: { method: string }) =>
        request.method === 'terminal.create'
          ? { ok: true, result: { terminal: { handle: 'terminal-second' } } }
          : call?.(request)
      )
      transport.sendInput('between\r', 'driving')
      await transport.connect({ url: '', callbacks: {} })
      await completeAttach()
      expect(transport.sendInput('live', 'driving')).toBe(true)
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toMatch(/live$/))
      expect(inputFrameTexts().join('')).toBe('live')
      transport.destroy?.()
    })
  })
})
