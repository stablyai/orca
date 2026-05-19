import { describe, expect, it } from 'vitest'
import {
  BrowserScreencastOpcode,
  decodeBrowserScreencastFrame,
  encodeBrowserScreencastFrame
} from './browser-screencast-protocol'

describe('browser screencast binary protocol', () => {
  it('round-trips frame metadata and image bytes', () => {
    const encoded = encodeBrowserScreencastFrame({
      opcode: BrowserScreencastOpcode.Frame,
      seq: 42,
      format: 'jpeg',
      metadata: {
        deviceWidth: 1280,
        deviceHeight: 720,
        pageScaleFactor: 1,
        timestamp: 123
      },
      image: new Uint8Array([1, 2, 3, 4])
    })

    const decoded = decodeBrowserScreencastFrame(encoded)

    expect(decoded).toEqual({
      opcode: BrowserScreencastOpcode.Frame,
      seq: 42,
      format: 'jpeg',
      metadata: {
        deviceWidth: 1280,
        deviceHeight: 720,
        pageScaleFactor: 1,
        timestamp: 123
      },
      image: new Uint8Array([1, 2, 3, 4])
    })
  })

  it('rejects unrelated binary frames', () => {
    expect(decodeBrowserScreencastFrame(new Uint8Array([0, 1, 2, 3]))).toBeNull()
  })

  it.each([
    { name: 'version', offset: 1, value: 2 },
    { name: 'opcode', offset: 2, value: 9 },
    { name: 'format', offset: 3, value: 9 }
  ])('rejects frames with an unsupported $name byte', ({ offset, value }) => {
    const encoded = encodeBrowserScreencastFrame({
      opcode: BrowserScreencastOpcode.Frame,
      seq: 1,
      format: 'jpeg',
      metadata: {},
      image: new Uint8Array([1])
    })
    encoded[offset] = value

    expect(decodeBrowserScreencastFrame(encoded)).toBeNull()
  })

  it('rejects frames whose metadata length exceeds the payload', () => {
    const encoded = encodeBrowserScreencastFrame({
      opcode: BrowserScreencastOpcode.Frame,
      seq: 1,
      format: 'jpeg',
      metadata: {},
      image: new Uint8Array([1])
    })
    new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).setUint32(
      8,
      encoded.byteLength,
      true
    )

    expect(decodeBrowserScreencastFrame(encoded)).toBeNull()
  })

  it('rejects frames with nonzero reserved header bytes', () => {
    const encoded = encodeBrowserScreencastFrame({
      opcode: BrowserScreencastOpcode.Frame,
      seq: 1,
      format: 'jpeg',
      metadata: {},
      image: new Uint8Array([1])
    })
    encoded[12] = 1

    expect(decodeBrowserScreencastFrame(encoded)).toBeNull()
  })

  it('rejects non-object metadata', () => {
    const encoded = encodeBrowserScreencastFrame({
      opcode: BrowserScreencastOpcode.Frame,
      seq: 1,
      format: 'jpeg',
      metadata: [] as unknown as Record<string, never>,
      image: new Uint8Array([1])
    })

    expect(decodeBrowserScreencastFrame(encoded)).toBeNull()
  })

  it('keeps only finite numeric metadata fields', () => {
    const encoded = encodeBrowserScreencastFrame({
      opcode: BrowserScreencastOpcode.Frame,
      seq: 1,
      format: 'jpeg',
      metadata: {
        deviceWidth: '1280',
        deviceHeight: 720,
        pageScaleFactor: Number.NaN,
        scrollOffsetX: 15,
        extra: 42
      } as unknown as Record<string, never>,
      image: new Uint8Array([1])
    })

    expect(decodeBrowserScreencastFrame(encoded)?.metadata).toEqual({
      deviceHeight: 720,
      scrollOffsetX: 15
    })
  })

  it('decodes image bytes as a view over the original frame buffer', () => {
    const encoded = encodeBrowserScreencastFrame({
      opcode: BrowserScreencastOpcode.Frame,
      seq: 1,
      format: 'jpeg',
      metadata: {},
      image: new Uint8Array([7, 8, 9])
    })

    const decoded = decodeBrowserScreencastFrame(encoded)

    expect(decoded?.image.buffer).toBe(encoded.buffer)
  })
})
