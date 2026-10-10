import { describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_LOCAL_STREAM_HEADER_BYTES,
  RuntimeLocalStreamFrameKind,
  createRuntimeLocalStreamFrameReader,
  encodeRuntimeLocalStreamFrame
} from './runtime-local-stream-protocol'

function createReader(maxFrameBytes = 1024) {
  const texts: string[] = []
  const binaries: Buffer[] = []
  const onFatal = vi.fn()
  const reader = createRuntimeLocalStreamFrameReader(
    {
      onText: (text) => texts.push(text),
      onBinary: (bytes) => binaries.push(bytes),
      onFatal
    },
    maxFrameBytes
  )
  return { reader, texts, binaries, onFatal }
}

describe('runtime local stream framing', () => {
  it('round-trips text and binary frames split at every byte boundary', () => {
    const wire = Buffer.concat([
      encodeRuntimeLocalStreamFrame(
        RuntimeLocalStreamFrameKind.Text,
        '{"id":"1","ok":true,"é":"ü"}'
      ),
      encodeRuntimeLocalStreamFrame(
        RuntimeLocalStreamFrameKind.Binary,
        new Uint8Array([0, 10, 255])
      ),
      encodeRuntimeLocalStreamFrame(RuntimeLocalStreamFrameKind.Text, '')
    ])
    const { reader, texts, binaries, onFatal } = createReader()
    for (let offset = 0; offset < wire.length; offset += 1) {
      reader.feed(wire.subarray(offset, offset + 1))
    }
    expect(texts).toEqual(['{"id":"1","ok":true,"é":"ü"}', ''])
    expect(binaries.map((bytes) => [...bytes])).toEqual([[0, 10, 255]])
    expect(onFatal).not.toHaveBeenCalled()
  })

  it('delivers several frames from one chunk in order', () => {
    const { reader, texts } = createReader()
    reader.feed(
      Buffer.concat(
        ['a', 'b', 'c'].map((text) =>
          encodeRuntimeLocalStreamFrame(RuntimeLocalStreamFrameKind.Text, text)
        )
      )
    )
    expect(texts).toEqual(['a', 'b', 'c'])
  })

  it('fails on a declared length above the cap before buffering the body', () => {
    const { reader, texts, onFatal } = createReader(8)
    const header = Buffer.alloc(RUNTIME_LOCAL_STREAM_HEADER_BYTES)
    header[0] = RuntimeLocalStreamFrameKind.Binary
    header.writeUInt32BE(9, 1)
    reader.feed(header)
    expect(onFatal).toHaveBeenCalledWith('frame_too_large')
    reader.feed(encodeRuntimeLocalStreamFrame(RuntimeLocalStreamFrameKind.Text, 'late'))
    expect(texts).toEqual([])
  })

  it('fails on an unknown frame kind', () => {
    const { reader, onFatal } = createReader()
    const frame = encodeRuntimeLocalStreamFrame(RuntimeLocalStreamFrameKind.Text, 'x')
    frame[0] = 7
    reader.feed(frame)
    expect(onFatal).toHaveBeenCalledWith('unknown_frame_kind')
  })
})
