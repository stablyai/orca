import { describe, expect, it } from 'vitest'

import { readPluginVideoHeader } from './plugin-video-format'

const be = (n: number, bytes: number) =>
  Array.from({ length: bytes }, (_, index) => Math.floor(n / 256 ** (bytes - 1 - index)) % 256)
const text = (value: string) => [...Buffer.from(value)]

function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat()
  return [...be(body.length + 8, 4), ...text(type), ...body]
}

function mp4Track(handler: string, codec: string, width: number, height: number): number[] {
  const entry = [...text(codec), ...Array(24).fill(0), ...be(width, 2), ...be(height, 2)]
  return box(
    'trak',
    box(
      'mdia',
      box('hdlr', Array(8).fill(0), text(handler), Array(12).fill(0)),
      box(
        'minf',
        // QuickTime files carry a data handler here too; only the media handler names the track.
        box('hdlr', Array(8).fill(0), text('alis'), Array(12).fill(0)),
        box('stbl', box('stsd', Array(4).fill(0), be(1, 4), be(entry.length + 4, 4), entry))
      )
    )
  )
}

function mp4(tracks: number[][], seconds = 30): Uint8Array {
  const mvhd = box('mvhd', Array(12).fill(0), be(1000, 4), be(seconds * 1000, 4), Array(80).fill(0))
  return Uint8Array.from([
    ...box('ftyp', text('isom'), be(512, 4), text('isomavc1')),
    ...box('moov', mvhd, ...tracks),
    ...box('mdat', Array(64).fill(7))
  ])
}

/** An EBML element with an 8-byte size, the longest form, so ids and sizes are both exercised. */
function element(id: number[], ...payload: number[][]): number[] {
  const body = payload.flat()
  return [...id, 0x01, ...be(body.length, 7), ...body]
}

function webm(
  codec: string,
  width: number,
  height: number,
  durationMs?: number,
  audio = false
): Uint8Array {
  const duration = new Uint8Array(8)
  new DataView(duration.buffer).setFloat64(0, durationMs ?? 0)
  const track = (type: number, codecId: string, video: number[]) =>
    element([0xae], element([0x83], [type]), element([0x86], text(codecId)), video)
  return Uint8Array.from([
    ...element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], text('webm'))),
    ...element(
      [0x18, 0x53, 0x80, 0x67],
      element(
        [0x15, 0x49, 0xa9, 0x66],
        element([0x2a, 0xd7, 0xb1], be(1_000_000, 3)),
        durationMs === undefined ? [] : element([0x44, 0x89], [...duration])
      ),
      element(
        [0x16, 0x54, 0xae, 0x6b],
        audio ? track(2, 'A_OPUS', []) : [],
        track(
          1,
          codec,
          element([0xe0], element([0xb0], be(width, 2)), element([0xba], be(height, 2)))
        )
      ),
      element([0x1f, 0x43, 0xb6, 0x75], Array(32).fill(9))
    )
  ])
}

function findStsd(bytes: number[]): number {
  return Buffer.from(bytes).indexOf('stsd')
}

describe('readPluginVideoHeader', () => {
  it('reads an MP4 and a WebM from their headers', () => {
    expect(readPluginVideoHeader(mp4([mp4Track('vide', 'avc1', 960, 540)]))).toEqual({
      container: 'mp4',
      codec: 'h264',
      width: 960,
      height: 540,
      durationMs: 30_000
    })
    expect(readPluginVideoHeader(webm('V_VP9', 1280, 720, 12_500))).toEqual({
      container: 'webm',
      codec: 'vp9',
      width: 1280,
      height: 720,
      durationMs: 12_500
    })
  })

  it('refuses images, audio, extra tracks and missing or negative lengths', () => {
    const oneTrack = 'video must have exactly one track, a video track with no audio'
    expect(readPluginVideoHeader(Buffer.from('\x89PNG\r\n\x1a\n'))).toBe(
      'must be an MP4 or WebM video'
    )
    const video = mp4Track('vide', 'avc1', 960, 540)
    const audio = mp4Track('soun', 'mp4a', 0, 0)
    expect(readPluginVideoHeader(mp4([audio]))).toBe(oneTrack)
    expect(readPluginVideoHeader(mp4([audio, video]))).toBe(oneTrack)
    expect(readPluginVideoHeader(mp4([video, video]))).toBe(oneTrack)
    expect(readPluginVideoHeader(webm('V_VP9', 960, 540, 1000, true))).toBe(oneTrack)
    expect(readPluginVideoHeader(webm('V_VP9', 960, 540))).toBe('video has no duration')
    expect(readPluginVideoHeader(webm('V_VP9', 960, 540, -5000))).toBe('video has no duration')
  })

  it('stops on hostile structure instead of recursing or reading past the end', () => {
    let nested = box('mdia')
    for (let depth = 0; depth < 5000; depth++) {
      nested = box('trak', nested)
    }
    const deep = Uint8Array.from([...box('ftyp', text('isom')), ...box('moov', nested)])
    expect(readPluginVideoHeader(deep)).toBe(
      'video must have exactly one track, a video track with no audio'
    )
    const truncated = webm('V_AV1', 960, 540, 1000).subarray(0, 60)
    expect(readPluginVideoHeader(truncated)).toBe('video headers are malformed')
    // A second sample description could switch the track to a size or codec never checked.
    const twoDescriptions = Uint8Array.from(
      [...mp4([mp4Track('vide', 'avc1', 960, 540)])].map((byte, index, all) =>
        // The stsd entry count is the 4 bytes after "stsd" and its version and flags.
        index === findStsd(all) + 11 ? 2 : byte
      )
    )
    expect(readPluginVideoHeader(twoDescriptions)).toBe('video headers are malformed')
  })
})
