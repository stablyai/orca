import { describe, expect, it } from 'vitest'
import {
  BrowserNetworkTunnelStreamFrameDecoder,
  encodeBrowserNetworkTunnelStreamFrame
} from './browser-network-tunnel-stream-framing'

describe('browser network tunnel stream framing', () => {
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
})
