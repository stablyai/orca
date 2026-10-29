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

import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let callbacks: MultiplexSubscriptionCallbacks = null
let resolvedHandle = 'terminal-1'
const {
  runtimeCall,
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

// The user is told when keys typed into a starting remote pane were dropped for safety.
describe('remote pre-bind typing discard notice', () => {
  it('tells the pane when startup work made it drop typing from before the terminal bound', async () => {
    const onTypingDiscardedBeforeBind = vi.fn()
    const { transport, created, waitForCreate } = await createGatedTransport({
      keepTypeAheadForNewTerminal: () => true,
      releasePreconnectInput: () => false,
      onTypingDiscardedBeforeBind
    })
    expect(transport.sendInput('make the tests pass\r', 'driving')).toBe(true)
    const connecting = transport.connect({ url: '', callbacks: {} })
    await waitForCreate()
    created.resolve({ handle: 'terminal-new' })
    await connecting
    await completeAttach()

    expect(onTypingDiscardedBeforeBind).toHaveBeenCalledTimes(1)
    transport.destroy?.()
  })

  it('says nothing when the typing reaches the terminal it was typed for', async () => {
    const onTypingDiscardedBeforeBind = vi.fn()
    const { transport, created, waitForCreate } = await createGatedTransport({
      keepTypeAheadForNewTerminal: () => true,
      onTypingDiscardedBeforeBind
    })
    expect(transport.sendInput('echo hi\r', 'driving')).toBe(true)
    const connecting = transport.connect({ url: '', callbacks: {} })
    await waitForCreate()
    created.resolve({ handle: 'terminal-new' })
    await connecting
    await completeAttach()
    await vi.waitFor(() => expect(inputFrameTexts().join('')).toBe('echo hi\r'))

    expect(onTypingDiscardedBeforeBind).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('says nothing once the pane is closed', async () => {
    const onTypingDiscardedBeforeBind = vi.fn()
    const { transport, created, waitForCreate } = await createGatedTransport({
      keepTypeAheadForNewTerminal: () => true,
      onTypingDiscardedBeforeBind
    })
    expect(transport.sendInput('lost\r', 'driving')).toBe(true)
    const connecting = transport.connect({ url: '', callbacks: {} })
    await waitForCreate()
    transport.destroy?.()
    created.resolve(new Error('offline'))
    await connecting
    await flushAsyncTicks()

    expect(onTypingDiscardedBeforeBind).not.toHaveBeenCalled()
  })
})
