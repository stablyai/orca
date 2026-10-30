// @vitest-environment happy-dom
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
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson
} from '../../../../shared/terminal-stream-protocol'
import type { PtyTransport } from './pty-transport-types'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeSubscribe,
  runtimeCall,
  subscriptionSendBinary,
  latestSubscribePayload,
  emitSnapshot,
  emitSnapshotFrame,
  inputFrameTexts,
  subscribeFrameCount,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

beforeEach(() => {
  resetRemoteRuntimeTransport()
  runtimeSubscribe.mockImplementation(
    async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
      subscriptionCallbacks = callbacks
      queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
      return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
    }
  )
})

/** Viewport frames in send order, so a test can check a claim precedes typing. */
function viewportAndInputFrames(): string[] {
  return subscriptionSendBinary.mock.calls.flatMap(([bytes]) => {
    const frame = decodeTerminalStreamFrame(bytes)
    if (frame?.opcode === TerminalStreamOpcode.Input) {
      return ['input']
    }
    if (
      frame?.opcode === TerminalStreamOpcode.ClaimViewport ||
      frame?.opcode === TerminalStreamOpcode.Resize
    ) {
      const size = decodeTerminalStreamJson<{ cols: number; rows: number }>(frame.payload)
      const kind = frame.opcode === TerminalStreamOpcode.ClaimViewport ? 'claim' : 'resize'
      return [`${kind} ${size?.cols}x${size?.rows}`]
    }
    return []
  })
}

function acknowledgeSubscribe(streamId: number, incarnationId?: string): void {
  subscriptionCallbacks?.onResponse({
    ok: true,
    result: {
      type: 'subscribed',
      streamId,
      ...(incarnationId
        ? {
            terminal: latestSubscribePayload().terminal,
            launchResult: { ptyId: 'pty', incarnationId },
            capabilities: { inputAck: 1 },
            inputLedgerId: 'ledger'
          }
        : {})
    }
  })
}

/** Connects, drops the link, and waits for the recovery resubscribe to go out. */
async function recoveringTransport(duringOutage?: (transport: PtyTransport) => void) {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1'
  })
  await transport.connect({ url: '', callbacks: {} })
  await vi.waitFor(() => expect(latestSubscribePayload()).toBeDefined())
  const first = latestSubscribePayload().streamId
  acknowledgeSubscribe(first)
  emitSnapshot(first, 'prompt$ ')
  await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
  subscriptionCallbacks?.onError?.({
    code: 'remote_runtime_unavailable',
    message: 'Remote runtime connection closed.'
  })
  duringOutage?.(transport)
  await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
  return { transport, streamId: latestSubscribePayload().streamId }
}

describe('remote recovery input at the subscribed ack', () => {
  it('sends held typing once the host acks the subscribe, before its snapshot finishes', async () => {
    const { transport, streamId } = await recoveringTransport()
    expect(transport.sendInput('held-', 'driving')).toBe(true)
    expect(inputFrameTexts()).toEqual([])

    acknowledgeSubscribe(streamId)
    await vi.waitFor(() => expect(inputFrameTexts()).toEqual(['held-']))
    // Typing during a large snapshot transfer goes straight out, after the held bytes.
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotStart, new Uint8Array())
    expect(transport.sendInput('live', 'driving')).toBe(true)
    await vi.waitFor(() => expect(inputFrameTexts().join('')).toBe('held-live'))
    expect(transport.isConnected()).toBe(false)

    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
    await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
    expect(inputFrameTexts().join('')).toBe('held-live')
    transport.destroy?.()
  })

  it('holds typing again when the acked stream drops before its snapshot ends', async () => {
    const { transport, streamId } = await recoveringTransport()
    acknowledgeSubscribe(streamId)
    subscriptionCallbacks?.onError?.({
      code: 'remote_runtime_unavailable',
      message: 'Remote runtime connection closed.'
    })
    expect(transport.sendInput('after-drop', 'driving')).toBe(true)
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(3))
    expect(inputFrameTexts()).toEqual([])
    const next = latestSubscribePayload().streamId
    acknowledgeSubscribe(next)
    await vi.waitFor(() => expect(inputFrameTexts()).toEqual(['after-drop']))
    transport.destroy?.()
  })

  it('holds typing again when recovery backs off while the acked stream stays installed', async () => {
    const { transport, streamId } = await recoveringTransport()
    acknowledgeSubscribe(streamId)
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'error', streamId, message: 'Remote runtime call queue is full.' }
    })
    expect(transport.sendInput('during-backoff', 'driving')).toBe(true)
    // Outlasts the input debounce, so an unheld key would have reached the stream.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(inputFrameTexts()).toEqual([])
    transport.destroy?.()
  })

  it('replays a viewport claim made during recovery before typing reaches the host', async () => {
    const { transport, streamId } = await recoveringTransport()
    // Claim lands after the resubscribe went out but before the host acked it.
    expect(transport.claimViewport?.(120, 40)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // A host still resolving the PTY ignores viewport frames, so none may be spent before its ack.
    subscriptionSendBinary.mockClear()
    acknowledgeSubscribe(streamId)
    expect(transport.sendInput('typed', 'driving')).toBe(true)
    await vi.waitFor(() => expect(inputFrameTexts()).toEqual(['typed']))
    expect(viewportAndInputFrames()).toEqual(['claim 120x40', 'resize 120x40', 'input'])
    transport.destroy?.()
  })

  it('keeps a claim made before the resubscribe until the host acks it', async () => {
    const { transport, streamId } = await recoveringTransport((outage) => {
      expect(outage.claimViewport?.(100, 30)).toBe(true)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // A host still resolving the PTY ignores viewport frames, so none may be spent before its ack.
    subscriptionSendBinary.mockClear()
    acknowledgeSubscribe(streamId)
    expect(transport.sendInput('typed', 'driving')).toBe(true)
    await vi.waitFor(() => expect(inputFrameTexts()).toEqual(['typed']))
    expect(viewportAndInputFrames()).toEqual(['claim 100x30', 'resize 100x30', 'input'])
    transport.destroy?.()
  })

  it('keeps recovering when replaying a claim on an ackless host fails its write', async () => {
    const { transport, streamId } = await recoveringTransport((outage) => {
      expect(outage.claimViewport?.(100, 30)).toBe(true)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    subscriptionSendBinary.mockImplementation((bytes) => {
      const opcode = decodeTerminalStreamFrame(bytes)?.opcode
      // The link is gone: the replayed claim and the immediate resubscribe both fail to write.
      if (
        opcode === TerminalStreamOpcode.ClaimViewport ||
        opcode === TerminalStreamOpcode.Subscribe
      ) {
        throw new Error('socket closed')
      }
    })
    // An older host never sends the subscribed ack; its snapshot end is the first readiness signal.
    emitSnapshot(streamId, 'prompt$ ')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(transport.isConnected()).toBe(false)
    expect(['recovering', 'backoff']).toContain(transport.getRecoveryState?.().phase)
    transport.destroy?.()
  })

  it('does not let a resize batched before a second outage overwrite the replayed claim', async () => {
    const { transport, streamId } = await recoveringTransport()
    acknowledgeSubscribe(streamId)
    expect(transport.resize(90, 25)).toBe(true)
    subscriptionCallbacks?.onError?.({
      code: 'remote_runtime_unavailable',
      message: 'Remote runtime connection closed.'
    })
    expect(transport.claimViewport?.(120, 40)).toBe(true)
    // Reconnect inside the 33ms viewport batch window.
    for (let turn = 0; turn < 50 && subscribeFrameCount() < 3; turn += 1) {
      await Promise.resolve()
    }
    expect(subscribeFrameCount()).toBe(3)
    const next = latestSubscribePayload().streamId
    subscriptionSendBinary.mockClear()
    acknowledgeSubscribe(next)
    // Outlasts the viewport batch window, so a surviving stale batch would have flushed.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(viewportAndInputFrames()).toEqual(['claim 120x40', 'resize 120x40'])
    transport.destroy?.()
  })

  it('keeps a deferred claim for the next stream when its replay fails to write', async () => {
    const { transport, streamId } = await recoveringTransport((outage) => {
      expect(outage.claimViewport?.(100, 30)).toBe(true)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    subscriptionSendBinary.mockImplementationOnce((bytes) => {
      if (decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.ClaimViewport) {
        throw new Error('socket closed')
      }
    })
    acknowledgeSubscribe(streamId)
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(3))
    const next = latestSubscribePayload().streamId
    subscriptionSendBinary.mockClear()
    acknowledgeSubscribe(next)
    await vi.waitFor(() =>
      expect(viewportAndInputFrames()).toEqual(['claim 100x30', 'resize 100x30'])
    )
    transport.destroy?.()
  })

  it('sends a claim made after the subscribed ack instead of dropping it', async () => {
    const { transport, streamId } = await recoveringTransport()
    acknowledgeSubscribe(streamId)
    subscriptionSendBinary.mockClear()
    expect(transport.claimViewport?.(132, 50)).toBe(true)
    expect(transport.sendInput('typed', 'driving')).toBe(true)
    await vi.waitFor(() => expect(inputFrameTexts()).toEqual(['typed']))
    expect(viewportAndInputFrames()).toEqual(['claim 132x50', 'resize 132x50', 'input'])

    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotStart, new Uint8Array())
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
    await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
    transport.destroy?.()
  })
})

it('reconciles contradictory current ACK proof without adopting launch metadata or relabelling mixed held input', async () => {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const { installTerminalLinkPtyMouseSuppression } =
    await import('./terminal-link-pty-mouse-suppression')
  const launches = vi.fn()
  const unavailable = vi.fn()
  const defaultCall = runtimeCall.getMockImplementation()
  let resolvedIncarnation = 'i1'
  let resolutionGate: Promise<void> | null = null
  runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
    if (request.method !== 'terminal.resolvePane') {
      return defaultCall?.(request)
    }
    if (resolutionGate) {
      await resolutionGate
    }
    return {
      ok: true,
      result: {
        terminal: {
          handle: 'terminal-1',
          tabId: 'tab-1',
          leafId: 'pane:1',
          worktreeId: 'wt-1',
          incarnationId: resolvedIncarnation
        }
      }
    }
  })
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1'
  })
  const element = document.createElement('div')
  document.body.append(element)
  const owner = installTerminalLinkPtyMouseSuppression(
    { element, clearSelection: vi.fn() },
    { candidate: () => 'link', eligible: () => true, canContinue: () => true }
  )
  const observe = transport.observeInputSource?.({
    beforeChange: owner.invalidateSource,
    afterChange: (source) => {
      const forward = (text: string): void => {
        source?.sendInput(text, 'driving')
      }
      owner.bindSource(
        source && { isCurrent: source.isCurrent, user: forward, unclassified: forward }
      )
    }
  })
  element.addEventListener('mousedown', () =>
    owner.handlePtyInput(
      '\x1b[<0;1;1M',
      () => {
        throw new Error('Ordinary route must not acquire a retained frame')
      },
      true
    )
  )
  try {
    await transport.connect({
      url: '',
      callbacks: { onLaunchResult: launches, onWriteUnavailable: unavailable }
    })
    await vi.waitFor(() => expect(latestSubscribePayload()).toBeDefined())
    acknowledgeSubscribe(latestSubscribePayload().streamId, 'i1')
    emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')
    const a = transport.getInputSource?.()
    if (!a) {
      throw new Error('Missing i1')
    }
    launches.mockClear()
    // Below-entry debounce and a genuinely retained owner frame coexist with ordinary outage keys.
    a.sendInput('old-debounce', 'driving')
    subscriptionCallbacks?.onError?.({
      code: 'remote_runtime_unavailable',
      message: 'Remote runtime connection closed.'
    })
    transport.sendInput('ordinary-held', 'driving')
    expect(a.claimViewport?.(120, 40)).toBe(true)
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }))
    acknowledgeSubscribe(latestSubscribePayload().streamId, 'i2')
    const b = transport.getInputSource?.()
    if (!b) {
      throw new Error('Missing fresh i2')
    }
    expect(a.isCurrent()).toBe(false)
    expect(b).not.toBe(a)
    expect(b.endpoint).toMatchObject({ incarnationId: 'i2' })
    expect(launches).not.toHaveBeenCalled()
    expect(viewportAndInputFrames()).not.toContain('claim 120x40')
    expect(b.claimViewport?.(132, 50)).toBe(true)
    expect(viewportAndInputFrames()).toContain('claim 132x50')
    await vi.waitFor(() => expect(inputFrameTexts().join('')).toContain('ordinary-held'))
    expect(inputFrameTexts().join('')).not.toContain('old-debounce')
    expect(inputFrameTexts().join('')).not.toContain('\x1b[<')
    b.sendInput('i2-live', 'driving')
    await vi.waitFor(() => expect(inputFrameTexts().join('')).toContain('i2-live'))
    // Cached same-h attach and snapshot preserve proof before a fresh resolver adopts metadata.
    let releaseResolution!: () => void
    resolutionGate = new Promise<void>((resolve) => {
      releaseResolution = resolve
    })
    emitSnapshot(latestSubscribePayload().streamId, 'still i2')
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      callbacks: { onWriteUnavailable: unavailable }
    })
    expect(transport.getInputSource?.()).toBe(b)
    expect(b.isCurrent()).toBe(true)
    transport.sendInput('ordinary-again', 'driving')
    b.sendInput('i2-held', 'driving')
    resolvedIncarnation = 'i2'
    releaseResolution()
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(3))
    acknowledgeSubscribe(latestSubscribePayload().streamId, 'i2')
    emitSnapshot(latestSubscribePayload().streamId, 'i2 prompt$ ')
    await vi.waitFor(() => expect(inputFrameTexts().join('')).toContain('i2-held'))
    expect(inputFrameTexts().join('')).not.toContain('ordinary-again')
    expect(transport.getInputSource?.()).toBe(b)
    expect(transport.sendInput('ordinary-fresh-i2', 'driving')).toBe(true)
    await vi.waitFor(() => expect(inputFrameTexts().join('')).toContain('ordinary-fresh-i2'))
    expect(transport.getInputSource?.()?.endpoint).toMatchObject({ incarnationId: 'i2' })
    expect(unavailable).not.toHaveBeenCalled()
  } finally {
    owner.dispose()
    observe?.dispose()
    transport.destroy?.()
    element.remove()
  }
})
