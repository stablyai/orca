import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE } from '../../runtime/remote-runtime-terminal-snapshot-state'
import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson
} from '../../../../shared/terminal-stream-protocol'

const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  subscriptionSendBinary,
  latestSubscribePayload,
  emitOutput,
  emitSnapshot,
  emitSnapshotFrame,
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

function subscribed(streamId: number): void {
  subscriptionCallbacks?.onResponse({
    ok: true,
    result: { type: 'subscribed', streamId, capabilities: { outputPause: 1 } }
  })
}

type AttachMode = 'attach' | 'connect-reattach' | 'connect-spawn'

async function attachTransport(mode: AttachMode) {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const onReplayData = vi.fn()
  const onStreamRecovered = vi.fn()
  const onConnect = vi.fn()
  const onError = vi.fn()
  const callbacks = { onReplayData, onStreamRecovered, onConnect, onError }
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1'
  })
  if (mode === 'attach') {
    // A pane restored after a client restart attaches to the host handle it persisted.
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 152,
      rows: 42,
      callbacks
    })
  } else {
    const fallback = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (request: { method: string }) =>
      request.method === 'terminal.create'
        ? {
            ok: true,
            result: {
              terminal: {
                handle: 'terminal-1',
                isReattach: mode === 'connect-reattach'
              }
            }
          }
        : fallback?.(request)
    )
    await transport.connect({ url: '', callbacks })
  }
  await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
  return {
    transport,
    streamId: latestSubscribePayload().streamId,
    ...callbacks
  }
}

// Idle agents send no new paint; imageless initial attach must pull retained host content instead of leaving a cursor-only pane (#18464/#21208/#23884).
describe('remote pane whose first attach replays no image', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it.each(['attach', 'connect-reattach'] as const)(
    'pulls the retained buffer when the initial pushed snapshot is empty (%s)',
    async (mode) => {
      const { transport, streamId, onReplayData, onStreamRecovered, onConnect } =
        await attachTransport(mode)

      emitSnapshot(streamId, '')
      subscribed(streamId)

      await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1))
      expect(onReplayData).not.toHaveBeenCalled()
      expect(onStreamRecovered).toHaveBeenCalledTimes(1)
      transport.destroy?.()
    }
  )

  it('pulls the retained buffer when the initial image holds only modes and a cursor', async () => {
    const { transport, streamId, onReplayData, onStreamRecovered, onConnect } =
      await attachTransport('attach')

    // A host model seeded only by bytes since attach: bracketed paste, cursor home, cursor shown.
    emitSnapshot(streamId, '\x1b[?2004h\x1b[H\x1b[?25h')
    subscribed(streamId)

    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1))
    // Still replayed so its modes apply; the pull then supplies the screen.
    expect(onReplayData).toHaveBeenCalledTimes(1)
    expect(onStreamRecovered).toHaveBeenCalledTimes(1)
    transport.destroy?.()
  })

  it('pulls the retained buffer when the initial snapshot exceeded the replay limit', async () => {
    const { transport, streamId, onReplayData, onStreamRecovered, onConnect, onError } =
      await attachTransport('attach')

    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({ kind: 'scrollback' })
    )
    const chunk = new Uint8Array(1024 * 1024).fill(0x61)
    for (let i = 0; i < 3; i += 1) {
      emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotChunk, chunk)
    }
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
    subscribed(streamId)

    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1))
    expect(onReplayData).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalledWith(REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE)
    expect(onStreamRecovered).toHaveBeenCalledTimes(1)
    transport.destroy?.()
  })

  it('does not pull again when the initial snapshot carried the screen', async () => {
    const { transport, streamId, onReplayData, onStreamRecovered, onConnect } =
      await attachTransport('attach')

    emitSnapshot(streamId, 'IDLE_AGENT_PROMPT')
    subscribed(streamId)

    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1))
    expect(onReplayData.mock.calls.map((call) => call[0])).toEqual(['IDLE_AGENT_PROMPT'])
    expect(onStreamRecovered).not.toHaveBeenCalled()
    emitOutput(streamId, 'LIVE')
    expect(onStreamRecovered).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('does not pull for a terminal this pane just created', async () => {
    const { transport, streamId, onStreamRecovered, onConnect } =
      await attachTransport('connect-spawn')

    emitSnapshot(streamId, '')
    subscribed(streamId)

    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1))
    expect(onStreamRecovered).not.toHaveBeenCalled()
    transport.destroy?.()
  })
})
