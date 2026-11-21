import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamJson,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../../../shared/terminal/stream/terminal-stream-protocol'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'

const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  subscriptionSendBinary,
  latestSubscribePayload,
  emitOutput,
  emitSnapshot,
  latestFrameForOpcode,
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

describe('createRemoteRuntimePtyTransport', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('paints a nonempty lossy initial snapshot once before resuming live output', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const terminal = new Terminal({ cols: 80, rows: 24 })
    let xtermWrites = 0
    const write = (data: string): void => {
      xtermWrites += 1
      terminal.write(data)
    }
    const onReplayData = vi.fn(write)
    const onData = vi.fn(write)
    const onConnect = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

    await transport.connect({ url: '', callbacks: { onReplayData, onData, onConnect } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()
    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({ kind: 'scrollback', cols: 80, rows: 24, seq: 41, truncated: true })
    )
    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotChunk,
      encodeTerminalStreamText('AUTHORITATIVE_INITIAL_MARKER')
    )
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
    const liveOutput = 'LIVE_AFTER_INITIAL'
    const liveSeq = 41 + liveOutput.length
    emitOutput(streamId, liveOutput, liveSeq)

    expect(onReplayData).toHaveBeenCalledOnce()
    expect(onReplayData).toHaveBeenCalledWith(
      'AUTHORITATIVE_INITIAL_MARKER',
      // The host's grid rides the snapshot so the pane replays it there.
      expect.objectContaining({ snapshotCols: 80, snapshotRows: 24 })
    )
    expect(onConnect).toHaveBeenCalledOnce()
    expect(onData).toHaveBeenCalledWith(liveOutput, expect.objectContaining({ seq: liveSeq }))
    await vi.waitFor(() => {
      const rendered = terminal.buffer.active.getLine(0)?.translateToString(true) ?? ''
      expect({ rendered, xtermWrites }).toEqual({
        rendered: 'AUTHORITATIVE_INITIAL_MARKERLIVE_AFTER_INITIAL',
        xtermWrites: 2
      })
    })
    terminal.dispose()
  })

  it('keeps initial replay separate from in-flight explicit binary snapshot requests', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onConnect = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1'
    })

    await transport.connect({ url: '', callbacks: { onReplayData, onConnect } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()

    const snapshotPromise = transport.serializeBuffer?.({ scrollbackRows: 5000 })
    expect(latestFrameForOpcode(TerminalStreamOpcode.SnapshotRequest)).toBeUndefined()

    emitSnapshot(streamId, 'initial replay')
    expect(onReplayData).toHaveBeenCalledWith('initial replay', { carriesNormalBuffer: true })
    expect(onConnect).toHaveBeenCalled()

    await vi.waitFor(() =>
      expect(latestFrameForOpcode(TerminalStreamOpcode.SnapshotRequest)).toBeDefined()
    )
    const snapshotRequestFrame = latestFrameForOpcode(TerminalStreamOpcode.SnapshotRequest)
    const snapshotRequestPayload = snapshotRequestFrame
      ? decodeTerminalStreamJson<{ requestId?: number }>(snapshotRequestFrame.payload)
      : null
    expect(snapshotRequestPayload?.requestId).toBe(1)

    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({
        kind: 'scrollback',
        requestId: snapshotRequestPayload?.requestId,
        cols: 100,
        rows: 20
      })
    )
    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotChunk,
      encodeTerminalStreamText('requested replay')
    )
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array())

    await expect(snapshotPromise).resolves.toEqual({
      data: 'requested replay',
      cols: 100,
      rows: 20,
      seq: undefined,
      source: undefined,
      carriesNormalBuffer: true
    })
    expect(onReplayData).toHaveBeenCalledTimes(1)
  })
})
