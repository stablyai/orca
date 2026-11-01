import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  describe('a brand-new pane', () => {
    it('delivers typing from before and during its first create to the terminal it makes', async () => {
      const { transport, created, waitForCreate } = await createGatedTransport({
        keepTypeAheadForNewTerminal: () => true
      })
      expect(transport.sendInput('ec', 'driving')).toBe(true)
      const connecting = transport.connect({ url: '', callbacks: {} })
      await waitForCreate()
      expect(transport.sendInput('ho hi\r', 'driving')).toBe(true)
      expect(inputFrameTexts()).toEqual([])
      created.resolve({ handle: 'terminal-new' })
      await connecting
      await completeAttach()
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toBe('echo hi\r'))
      transport.destroy?.()
    })

    it('drops its typing when startup work appeared before the terminal bound', async () => {
      const { transport, created, waitForCreate } = await createGatedTransport({
        keepTypeAheadForNewTerminal: () => true,
        releasePreconnectInput: () => false
      })
      expect(transport.sendInput('make the tests pass\r', 'driving')).toBe(true)
      const connecting = transport.connect({ url: '', callbacks: {} })
      await waitForCreate()
      created.resolve({ handle: 'terminal-new' })
      await connecting
      await completeAttach()
      expect(transport.sendInput('live', 'driving')).toBe(true)
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toMatch(/live$/))
      expect(inputFrameTexts().join('')).toBe('live')
      transport.destroy?.()
    })

    it('drops its typing when the first create binds no terminal', async () => {
      const { transport, created, waitForCreate } = await createGatedTransport({
        keepTypeAheadForNewTerminal: () => true
      })
      const accepted = transport.sendInputAccepted?.('lost\r', 'driving')
      const connecting = transport.connect({ url: '', callbacks: {} })
      await waitForCreate()
      created.resolve(new Error('offline'))
      await connecting
      await expect(accepted).resolves.toBe(false)
      await flushAsyncTicks()
      expect(inputFrameTexts()).toEqual([])
      transport.destroy?.()
    })
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

    it('drops its typing when replayed history appeared before the terminal bound', async () => {
      let blank = true
      const { transport, created, waitForCreate } = await createGatedTransport({
        keepTypeAheadForNewTerminal: () => blank
      })
      const connecting = transport.connect({ url: '', callbacks: {} })
      await waitForCreate()
      expect(transport.sendInput('typed on old pixels\r', 'driving')).toBe(true)
      blank = false
      created.resolve({ handle: 'terminal-new' })
      await connecting
      await completeAttach()
      expect(transport.sendInput('live', 'driving')).toBe(true)
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toMatch(/live$/))
      expect(inputFrameTexts().join('')).toBe('live')
      transport.destroy?.()
    })
  })

  // A remount shows the pane's terminal id before its deferred attach starts; keys typed then are real.
  describe('a remounted pane attaching its terminal', () => {
    async function attachRemountedPane(
      options: Record<string, unknown> = {},
      beforeAttachCompletes?: () => void
    ) {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1',
        bufferInputUntilConnect: true,
        ...options
      })
      expect(transport.sendInput('ec', 'driving')).toBe(true)
      transport.attach({ existingPtyId: ORIGINAL_ID, cols: 80, rows: 24, callbacks: {} })
      expect(transport.sendInput('ho hi\r', 'driving')).toBe(true)
      expect(inputFrameTexts()).toEqual([])
      beforeAttachCompletes?.()
      await completeAttach()
      return transport
    }

    it('delivers typing from before and during the attach to the terminal it names', async () => {
      const transport = await attachRemountedPane()
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toBe('echo hi\r'))
      transport.destroy?.()
    })

    it('drops that typing when the host now holds another terminal', async () => {
      resolvedHandle = 'terminal-2'
      const transport = await attachRemountedPane()
      await vi.waitFor(() => expect(transport.getPtyId()).toBe('remote:env-1@@terminal-2'))
      expect(transport.sendInput('live', 'driving')).toBe(true)
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toMatch(/live$/))
      expect(inputFrameTexts().join('')).not.toContain('echo')
      transport.destroy?.()
    })

    it('drops typing from before the attach when the pane has startup work', async () => {
      const transport = await attachRemountedPane({ releasePreconnectInput: () => false })
      expect(transport.sendInput('live', 'driving')).toBe(true)
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toMatch(/live$/))
      expect(inputFrameTexts().join('')).toBe('ho hi\rlive')
      transport.destroy?.()
    })

    it('drops that typing when startup work appears during the attach', async () => {
      let startupWork = false
      const transport = await attachRemountedPane(
        { releasePreconnectInput: () => !startupWork },
        () => {
          startupWork = true
        }
      )
      expect(transport.sendInput('live', 'driving')).toBe(true)
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toMatch(/live$/))
      expect(inputFrameTexts().join('')).toBe('live')
      transport.destroy?.()
    })

    it('delivers an acknowledged interrupt typed during the attach in order', async () => {
      const sends: string[] = []
      const call = runtimeCall.getMockImplementation()
      runtimeCall.mockImplementation(
        async (request: { method: string; params?: { text?: string } }) => {
          if (request.method !== 'terminal.send') {
            return call?.(request)
          }
          sends.push(request.params?.text ?? '')
          return { ok: true, result: { send: { accepted: true } } }
        }
      )
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1',
        bufferInputUntilConnect: true
      })
      expect(transport.sendInput('sleep 9', 'driving')).toBe(true)
      transport.attach({ existingPtyId: ORIGINAL_ID, cols: 80, rows: 24, callbacks: {} })
      const interrupt = transport.sendInputAccepted?.('\x03', 'driving')
      expect(transport.sendInput('ls\r', 'driving')).toBe(true)
      await completeAttach()
      await expect(interrupt).resolves.toBe(true)
      expect(sends).toEqual(['sleep 9\x03'])
      await vi.waitFor(() => expect(inputFrameTexts()).toEqual(['ls\r']))
      transport.destroy?.()
    })

    it('drops that typing when the attach fails without binding a terminal', async () => {
      const call = runtimeCall.getMockImplementation()
      runtimeCall.mockImplementation(async (request: { method: string }) => {
        if (request.method === 'terminal.resolvePane') {
          throw new Error('no_connected_pty')
        }
        return call?.(request)
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1',
        bufferInputUntilConnect: true
      })
      const accepted = transport.sendInputAccepted?.('echo hi\r', 'driving')
      transport.attach({ existingPtyId: ORIGINAL_ID, cols: 80, rows: 24, callbacks: {} })
      await expect(accepted).resolves.toBe(false)
      transport.destroy?.()
    })

    it('never delivers that typing to a terminal a later fresh connect creates', async () => {
      const resolution = createDeferred<void>()
      const call = runtimeCall.getMockImplementation()
      runtimeCall.mockImplementation(async (request: { method: string }) => {
        if (request.method === 'terminal.resolvePane') {
          await resolution.promise
        }
        if (request.method === 'terminal.create') {
          return { ok: true, result: { terminal: { handle: 'terminal-new' } } }
        }
        return call?.(request)
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1',
        bufferInputUntilConnect: true
      })
      expect(transport.sendInput('rm -rf build\r', 'driving')).toBe(true)
      transport.attach({ existingPtyId: ORIGINAL_ID, cols: 80, rows: 24, callbacks: {} })
      await transport.connect({ url: '', callbacks: {} })
      await completeAttach()
      resolution.resolve()
      expect(transport.sendInput('live', 'driving')).toBe(true)
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toMatch(/live$/))
      expect(inputFrameTexts().join('')).toBe('live')
      transport.destroy?.()
    })
  })
})
