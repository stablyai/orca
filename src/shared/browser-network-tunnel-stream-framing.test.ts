import { describe, expect, it, vi } from 'vitest'
import {
  BrowserNetworkTunnelStreamFrameDecoder,
  BrowserNetworkTunnelStreamFrameWriter,
  encodeBrowserNetworkTunnelStreamFrame
} from './browser-network-tunnel-stream-framing'

describe('browser network tunnel stream framing', () => {
  it('decodes fragmented and coalesced frames without changing their bytes', () => {
    const frames: Uint8Array[] = []
    const errors: Error[] = []
    const decoder = new BrowserNetworkTunnelStreamFrameDecoder(
      (frame) => frames.push(frame),
      (error) => errors.push(error)
    )
    const first = encodeBrowserNetworkTunnelStreamFrame(new Uint8Array([1, 2, 3]))
    const second = encodeBrowserNetworkTunnelStreamFrame(new Uint8Array([4, 5]))
    const combined = new Uint8Array(first.byteLength + second.byteLength)
    combined.set(first)
    combined.set(second, first.byteLength)

    decoder.feed(combined.subarray(0, 2))
    decoder.feed(combined.subarray(2, 8))
    decoder.feed(combined.subarray(8))

    expect(frames).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])
    expect(errors).toEqual([])
  })

  it('fails closed on oversized or empty frames', () => {
    const oversizedError = vi.fn()
    const oversized = new Uint8Array(4)
    new DataView(oversized.buffer).setUint32(0, 2 * 1024 * 1024, false)
    const oversizedDecoder = new BrowserNetworkTunnelStreamFrameDecoder(() => {}, oversizedError)
    const emptyError = vi.fn()
    const emptyDecoder = new BrowserNetworkTunnelStreamFrameDecoder(() => {}, emptyError)

    oversizedDecoder.feed(oversized)
    emptyDecoder.feed(new Uint8Array([0, 0, 0, 0]))

    expect(oversizedError).toHaveBeenCalledOnce()
    expect(emptyError).toHaveBeenCalledOnce()
  })

  it('fails the stream when a frame consumer rejects input', () => {
    const onError = vi.fn()
    const decoder = new BrowserNetworkTunnelStreamFrameDecoder(() => {
      throw new Error('consumer rejected frame')
    }, onError)

    decoder.feed(encodeBrowserNetworkTunnelStreamFrame(new Uint8Array([1])))

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'consumer rejected frame' })
    )
  })

  it.each([1, 2, 3, 16, 256, 4096, 65556])(
    'preserves maximum-size frames split into %i-byte chunks',
    (chunkSize) => {
      const payload = Uint8Array.from({ length: 65552 }, (_, index) => index % 251)
      const encoded = encodeBrowserNetworkTunnelStreamFrame(payload)
      const frames: Uint8Array[] = []
      const onError = vi.fn()
      const decoder = new BrowserNetworkTunnelStreamFrameDecoder(
        (frame) => frames.push(frame),
        onError
      )
      for (let offset = 0; offset < encoded.length; offset += chunkSize) {
        decoder.feed(encoded.subarray(offset, offset + chunkSize))
      }
      expect(frames).toEqual([payload])
      expect(onError).not.toHaveBeenCalled()
    }
  )

  it('copies fragmented bytes once instead of recopying the growing carry', () => {
    const encoded = encodeBrowserNetworkTunnelStreamFrame(new Uint8Array(65536))
    const decoder = new BrowserNetworkTunnelStreamFrameDecoder(
      () => {},
      () => {}
    )
    const originalSet = Uint8Array.prototype.set
    let copiedBytes = 0
    const set = vi
      .spyOn(Uint8Array.prototype, 'set')
      .mockImplementation(function (this: Uint8Array, source, offset) {
        copiedBytes += source.length
        originalSet.call(this, source, offset)
      })
    try {
      for (const byte of encoded) {
        decoder.feed(new Uint8Array([byte]))
      }
      expect(copiedBytes).toBe(encoded.length)
    } finally {
      set.mockRestore()
    }
  })

  it('owns partial input and emitted frames independently of caller buffers', () => {
    const frames: Uint8Array[] = []
    const decoder = new BrowserNetworkTunnelStreamFrameDecoder(
      (frame) => frames.push(frame),
      () => {}
    )
    const first = new Uint8Array([0, 0, 0, 3, 1])
    decoder.feed(first)
    first.fill(255)
    const rest = new Uint8Array([2, 3])
    decoder.feed(rest)
    rest.fill(255)
    decoder.feed(encodeBrowserNetworkTunnelStreamFrame(new Uint8Array([4])))
    expect(frames).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([4])])
  })

  it('enforces the retained cap before decoding complete frames in a feed', () => {
    const onFrame = vi.fn()
    const onError = vi.fn()
    const decoder = new BrowserNetworkTunnelStreamFrameDecoder(onFrame, onError, 16, 8)
    decoder.feed(new Uint8Array([0, 0]))
    decoder.feed(new Uint8Array([0, 1, 7, 0, 0, 0, 1]))
    decoder.feed(new Uint8Array([8]))
    expect(onFrame).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'browser_tunnel_stream_buffer_overflow' })
    )
  })

  it('counts the retained header and payload against the exact cap', () => {
    const onFrame = vi.fn()
    const onError = vi.fn()
    const decoder = new BrowserNetworkTunnelStreamFrameDecoder(onFrame, onError, 16, 7)
    decoder.feed(new Uint8Array([0, 0, 0, 3, 1]))
    decoder.feed(new Uint8Array([2, 3]))
    expect(onFrame).toHaveBeenCalledExactlyOnceWith(new Uint8Array([1, 2, 3]))
    expect(onError).not.toHaveBeenCalled()
  })

  it('stops decoding coalesced frames when the callback closes the decoder', () => {
    const onFrame = vi.fn(() => decoder.close())
    const onError = vi.fn()
    const decoder = new BrowserNetworkTunnelStreamFrameDecoder(onFrame, onError)
    decoder.feed(new Uint8Array([0, 0, 0, 1, 7, 0, 0, 0, 1, 8]))
    decoder.feed(new Uint8Array([0, 0, 0, 1, 9]))
    expect(onFrame).toHaveBeenCalledExactlyOnceWith(new Uint8Array([7]))
    expect(onError).not.toHaveBeenCalled()
  })

  it('serializes writes and rejects bounded queue overflow', () => {
    const callbacks: ((error?: Error | null) => void)[] = []
    const writes: Uint8Array[] = []
    const onError = vi.fn()
    const writer = new BrowserNetworkTunnelStreamFrameWriter(
      (bytes, callback) => {
        writes.push(bytes)
        callbacks.push(callback)
      },
      onError,
      { maxQueuedBytes: 16, maxQueuedFrames: 2 }
    )

    expect(writer.send(new Uint8Array([1, 2]))).toBe(true)
    expect(writer.send(new Uint8Array([3, 4]))).toBe(true)
    expect(writer.send(new Uint8Array([5, 6]))).toBe(false)
    expect(writes).toHaveLength(1)

    callbacks.shift()?.()
    expect(writes).toHaveLength(2)
    callbacks.shift()?.()
    expect(writer.queuedBytes).toBe(0)
    expect(onError).not.toHaveBeenCalled()
  })
})
