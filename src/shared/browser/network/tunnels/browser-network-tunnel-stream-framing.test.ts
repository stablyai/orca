import { describe, expect, it, vi } from 'vitest'
import {
  BrowserNetworkTunnelStreamFrameDecoder,
  BrowserNetworkTunnelStreamFrameWriter,
  encodeBrowserNetworkTunnelStreamFrame
} from './browser-network-tunnel-stream-framing'

describe('browser network tunnel stream framing', () => {
  it.each([0, 2 * 1024 * 1024])('stays closed after rejecting a %i-byte frame', (length) => {
    const onFrame = vi.fn()
    const onError = vi.fn()
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(0, length, false)
    const decoder = new BrowserNetworkTunnelStreamFrameDecoder(onFrame, onError)

    decoder.feed(header)
    decoder.feed(encodeBrowserNetworkTunnelStreamFrame(new Uint8Array([1])))

    expect(onFrame).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'browser_tunnel_stream_frame_invalid' })
    )
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
