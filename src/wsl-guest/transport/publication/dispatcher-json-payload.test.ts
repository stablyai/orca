import { describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import type { RelayClientSinkOptions, SinkWriteSettlement } from '../writer/dispatcher-writer-sink'
import { encodeKeepAliveFrame, type JsonRpcNotification } from '../wire/protocol'

type DecodedFrame = {
  id: number
  ack: number
  message: JsonRpcNotification
  payload: Buffer
}

function decodeFrame(frame: Buffer): DecodedFrame {
  const length = frame.readUInt32BE(9)
  const payload = frame.subarray(13, 13 + length)
  return {
    id: frame.readUInt32BE(1),
    ack: frame.readUInt32BE(5),
    message: JSON.parse(payload.toString('utf8')),
    payload
  }
}

class DrainSink {
  readonly frames: Buffer[] = []
  private readonly drainWaiters = new Set<() => void>()
  private writableBytes = 0
  private blocked = true

  constructor(
    highWaterMark = 4 * 1024 * 1024,
    private readonly mutateFrames = false
  ) {
    this.options = {
      writableLength: () => this.writableBytes,
      writableHighWaterMark: () => highWaterMark,
      waitWriteDrain: (callback) => {
        this.drainWaiters.add(callback)
        return () => this.drainWaiters.delete(callback)
      }
    }
  }

  readonly options: RelayClientSinkOptions

  write = (data: Buffer): boolean => {
    this.frames.push(Buffer.from(data))
    if (this.mutateFrames) {
      data.fill(0x78, 13)
    }
    if (!this.blocked) {
      return true
    }
    this.writableBytes = data.length
    return false
  }

  drain(): void {
    this.blocked = false
    this.writableBytes = 0
    for (const callback of Array.from(this.drainWaiters)) {
      callback()
    }
  }
}

describe('RelayDispatcher prepared JSON payloads', () => {
  it('sends the same payload with independent sequence and ACK headers', () => {
    const primary = new DrainSink(undefined, true)
    const secondary = new DrainSink()
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const secondaryId = dispatcher.attachClient(secondary.write, secondary.options)
    try {
      dispatcher.notify('test.blocker')
      dispatcher.notifyClient(1, 'test.primary-only')

      dispatcher.notify('workspace.changed', { revision: 7 })
      dispatcher.feed(encodeKeepAliveFrame(41, 0))
      dispatcher.feedClient(secondaryId, encodeKeepAliveFrame(73, 0))

      primary.drain()
      secondary.drain()

      const primaryShared = primary.frames
        .map(decodeFrame)
        .find((frame) => frame.message.method === 'workspace.changed')
      const secondaryShared = secondary.frames
        .map(decodeFrame)
        .find((frame) => frame.message.method === 'workspace.changed')
      expect(primaryShared).toMatchObject({ id: 3, ack: 41 })
      expect(secondaryShared).toMatchObject({ id: 2, ack: 73 })
      expect(primaryShared?.payload.equals(secondaryShared!.payload)).toBe(true)
    } finally {
      dispatcher.dispose()
    }
  })

  it('does not send a rejected producer frame', () => {
    const frames: Buffer[] = []
    const dispatcher = new RelayDispatcher(
      (frame) => {
        frames.push(Buffer.from(frame))
        return true
      },
      { writableLength: () => 0, writableHighWaterMark: () => 1024 }
    )
    try {
      expect(
        dispatcher.publishProducerNotification(
          1,
          'fs.changed',
          { events: [{ path: '/repo/a' }] },
          {
            logDrop: false
          }
        )
      ).toBe(false)
      expect(frames).toEqual([])
    } finally {
      dispatcher.dispose()
    }
  })

  it('snapshots wire data and retains only PTY admission identity while queued', () => {
    const sink = new DrainSink()
    const dispatcher = new RelayDispatcher(sink.write, sink.options)
    const params: Record<string, unknown> = {
      id: 'pty-1',
      data: 'before'.repeat(4096),
      deliveryToken: 'token-before',
      clientGeneration: 3,
      ownerGeneration: 5,
      ptyIncarnation: 'incarnation-before'
    }
    const admissions: Readonly<Record<string, unknown>>[] = []
    dispatcher.registerPtyDataPublicationAdmission((_clientId, admissionParams) => {
      admissions.push(admissionParams)
      return admissionParams.deliveryToken === 'token-before'
    })
    dispatcher.notify('test.blocker')
    const settled = vi.fn<(result: SinkWriteSettlement) => void>()
    expect(dispatcher.tryNotifyPtyDataToClient(1, params, settled)).toBe(true)
    admissions.length = 0
    params.data = 'after'
    params.deliveryToken = 'token-after'
    params.clientGeneration = 99
    params.ownerGeneration = 100
    params.ptyIncarnation = 'incarnation-after'

    sink.drain()

    const publication = sink.frames
      .map(decodeFrame)
      .find((frame) => frame.message.method === 'pty.data')
    expect(publication?.message.params).toMatchObject({
      data: 'before'.repeat(4096),
      deliveryToken: 'token-before',
      clientGeneration: 3,
      ownerGeneration: 5,
      ptyIncarnation: 'incarnation-before'
    })
    expect(admissions).toEqual([
      {
        id: 'pty-1',
        deliveryToken: 'token-before',
        clientGeneration: 3,
        ownerGeneration: 5,
        ptyIncarnation: 'incarnation-before'
      }
    ])
    expect(settled).toHaveBeenCalledExactlyOnceWith({ ok: true })
    dispatcher.dispose()
  })

  it('retires queued PTY data without consuming sequence or losing settlement', () => {
    const sink = new DrainSink()
    const dispatcher = new RelayDispatcher(sink.write, sink.options)
    let admitted = true
    dispatcher.registerPtyDataPublicationAdmission(() => admitted)
    try {
      dispatcher.notify('test.blocker')
      const retired = vi.fn<(result: SinkWriteSettlement) => void>()
      expect(dispatcher.tryNotifyPtyDataToClient(1, { id: 'pty-1', data: 'retire' }, retired)).toBe(
        true
      )
      admitted = false
      sink.drain()
      expect(retired).toHaveBeenCalledExactlyOnceWith({
        ok: false,
        error: expect.objectContaining({ message: 'PTY publication retired' })
      })
      admitted = true
      expect(dispatcher.tryNotifyPtyDataToClient(1, { id: 'pty-1', data: 'next' }, vi.fn())).toBe(
        true
      )
      const published = sink.frames
        .map(decodeFrame)
        .find((frame) => frame.message.method === 'pty.data')
      expect(published).toMatchObject({ id: 2 })
      expect(published?.message.params?.data).toBe('next')
    } finally {
      dispatcher.dispose()
    }
  })

  it('keeps the original payloads of queued bulk frames', async () => {
    const sink = new DrainSink()
    const dispatcher = new RelayDispatcher(sink.write, sink.options)
    try {
      dispatcher.notify('test.blocker', { data: 'x'.repeat(16 * 1024) })
      const originalData = Buffer.alloc(256 * 1024, 0x61).toString('base64')
      const pending = Array.from({ length: 16 }, (_, index) => {
        const params = { streamId: index + 1, seq: 1, data: originalData }
        const publication = dispatcher.notifyBulk('fs.streamChunk', params)
        params.data = 'mutated'
        return publication
      })

      await Promise.resolve()

      sink.drain()
      await Promise.all(pending)

      const chunks = sink.frames
        .map(decodeFrame)
        .filter((frame) => frame.message.method === 'fs.streamChunk')
      expect(chunks).toHaveLength(16)
      expect(chunks.every((frame) => frame.message.params?.data === originalData)).toBe(true)
    } finally {
      dispatcher.dispose()
    }
  })

  it('sends the same original bulk payload to both clients', async () => {
    const primary = new DrainSink()
    const secondary = new DrainSink()
    primary.drain()
    secondary.drain()
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    dispatcher.attachClient(secondary.write, secondary.options)
    try {
      const params = { streamId: 4, seq: 8, data: 'before' }
      const pending = dispatcher.notifyBulk('git.responseChunk', params)
      params.data = 'after'

      await pending

      expect(decodeFrame(primary.frames[0]).message.params?.data).toBe('before')
      expect(decodeFrame(secondary.frames[0]).message.params?.data).toBe('before')
    } finally {
      dispatcher.dispose()
    }
  })
})
