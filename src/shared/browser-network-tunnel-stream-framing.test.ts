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
