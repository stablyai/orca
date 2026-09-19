import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamJson,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

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

  it('replays remote scrollback through the parser without firing stale attention events', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onTitleChange = vi.fn()
    const onBell = vi.fn()
    const onAgentStatus = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      onTitleChange,
      onBell,
      onAgentStatus
    })

    await transport.connect({ url: '', callbacks: { onReplayData } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()
    emitSnapshot(
      streamId,
      'before\x1b]9999;{"state":"working","prompt":"old","agentType":"codex"}\x07after\x1b]0;Remote title\x07\x07'
    )

    expect(onReplayData).toHaveBeenCalledWith('beforeafter\x1b]0;Remote title\x07\x07')
    await vi.waitFor(() =>
      expect(onTitleChange).toHaveBeenCalledWith('Remote title', 'Remote title')
    )
    expect(onAgentStatus).not.toHaveBeenCalled()
    expect(onBell).not.toHaveBeenCalled()
  })

  it('replays binary snapshot chunks without firing stale attention events', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onTitleChange = vi.fn()
    const onBell = vi.fn()
    const onAgentStatus = vi.fn()
    const onConnect = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      onTitleChange,
      onBell,
      onAgentStatus
    })

    await transport.connect({ url: '', callbacks: { onReplayData, onConnect } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()
    emitSnapshot(
      streamId,
      'before\x1b]9999;{"state":"working","prompt":"old","agentType":"codex"}\x07after'
    )

    expect(onReplayData).toHaveBeenCalledWith('beforeafter')
    expect(onAgentStatus).not.toHaveBeenCalled()
    expect(onBell).not.toHaveBeenCalled()
    expect(onConnect).toHaveBeenCalled()
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

  it('resolves explicit binary snapshot requests without replaying into xterm', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onData = vi.fn()
    const onConnect = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1'
    })

    await transport.connect({ url: '', callbacks: { onReplayData, onData, onConnect } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()
    emitSnapshot(streamId, 'initial')
    expect(onReplayData).toHaveBeenCalledWith('initial')
    expect(onConnect).toHaveBeenCalled()

    const snapshotPromise = transport.serializeBuffer?.({ scrollbackRows: 5000 })
    await vi.waitFor(() =>
      expect(latestFrameForOpcode(TerminalStreamOpcode.SnapshotRequest)).toBeDefined()
    )
    const snapshotRequestFrame = latestFrameForOpcode(TerminalStreamOpcode.SnapshotRequest)
    const snapshotRequestPayload = snapshotRequestFrame
      ? decodeTerminalStreamJson<{ requestId?: number; scrollbackRows?: number }>(
          snapshotRequestFrame.payload
        )
      : null
    expect(snapshotRequestFrame?.streamId).toBe(streamId)
    expect(snapshotRequestPayload).toMatchObject({ requestId: 1, scrollbackRows: 5000 })

    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({
        kind: 'scrollback',
        requestId: snapshotRequestPayload?.requestId,
        cols: 132,
        rows: 43,
        seq: 17,
        source: 'headless'
      })
    )
    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotChunk,
      encodeTerminalStreamText('requested snapshot')
    )
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array())

    await expect(snapshotPromise).resolves.toEqual({
      data: 'requested snapshot',
      cols: 132,
      rows: 43,
      seq: 17,
      source: 'headless'
    })
    expect(onReplayData).toHaveBeenCalledTimes(1)
    expect(onData).not.toHaveBeenCalledWith('requested snapshot', expect.anything())
  })

  it('forwards requested snapshot availability through the remote transport', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

    await transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()
    emitSnapshot(streamId, 'initial')

    const outcomePromise = transport.serializeBufferOutcome?.({ scrollbackRows: 5000 })
    await vi.waitFor(() =>
      expect(latestFrameForOpcode(TerminalStreamOpcode.SnapshotRequest)).toBeDefined()
    )
    const requestFrame = latestFrameForOpcode(TerminalStreamOpcode.SnapshotRequest)
    const request = requestFrame
      ? decodeTerminalStreamJson<{ requestId?: number }>(requestFrame.payload)
      : null
    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({
        requestId: request?.requestId,
        cols: 120,
        rows: 40,
        unavailable: 'no-serializable-buffer'
      })
    )
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array())

    await expect(outcomePromise).resolves.toMatchObject({
      availability: { kind: 'retry-worthy', cause: 'host-no-serializable-buffer' },
      snapshot: { data: '' }
    })
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
    expect(onReplayData).toHaveBeenCalledWith('initial replay')
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
      source: undefined
    })
    expect(onReplayData).toHaveBeenCalledTimes(1)
  })

  it('bounds oversized binary snapshots without closing the live stream', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onData = vi.fn()
    const onError = vi.fn()
    const onConnect = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1'
    })

    await transport.connect({ url: '', callbacks: { onReplayData, onData, onError, onConnect } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()

    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({ kind: 'scrollback' })
    )
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotChunk, new Uint8Array(1024 * 1024))
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotChunk, new Uint8Array(1024 * 1024))
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotChunk, new Uint8Array(1))
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
    emitOutput(streamId, 'live-after-overflow')

    expect(onReplayData).not.toHaveBeenCalled()
    // Why: an oversized snapshot is skipped but live output continues, so the
    // transport classifies it as benign and never surfaces a fatal red banner.
    expect(onError).not.toHaveBeenCalled()
    expect(onConnect).toHaveBeenCalled()
    expect(onData).toHaveBeenCalledWith('live-after-overflow', expect.objectContaining({ seq: 1 }))
  })
})
