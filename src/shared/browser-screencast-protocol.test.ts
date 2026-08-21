import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_SCREENCAST_MAX_METADATA_BYTES,
  BROWSER_SCREENCAST_METADATA_JSON_STRUCTURE_LIMITS,
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

  it('rejects oversized metadata before decoding it', () => {
    const encoded = new Uint8Array(16 + BROWSER_SCREENCAST_MAX_METADATA_BYTES + 1)
    const view = new DataView(encoded.buffer)
    encoded[0] = 0x62
    encoded[1] = 1
    encoded[2] = BrowserScreencastOpcode.Frame
    encoded[3] = 1
    view.setUint32(8, BROWSER_SCREENCAST_MAX_METADATA_BYTES + 1, true)

    expect(decodeBrowserScreencastFrame(encoded)).toBeNull()
  })

  it('rejects excessive metadata nesting before JSON.parse', () => {
    const parseSpy = vi.spyOn(JSON, 'parse')
    try {
      const depth = BROWSER_SCREENCAST_METADATA_JSON_STRUCTURE_LIMITS.nestingDepth + 1
      const metadata = new TextEncoder().encode(`${'['.repeat(depth)}0${']'.repeat(depth)}`)
      const encoded = new Uint8Array(16 + metadata.byteLength)
      const view = new DataView(encoded.buffer)
      encoded[0] = 0x62
      encoded[1] = 1
      encoded[2] = BrowserScreencastOpcode.Frame
      encoded[3] = 1
      view.setUint32(8, metadata.byteLength, true)
      encoded.set(metadata, 16)

      expect(decodeBrowserScreencastFrame(encoded)).toBeNull()
      expect(parseSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
    }
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
