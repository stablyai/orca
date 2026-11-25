/**
 * Reads a video's container, codec, size and length from its box (MP4) or element (WebM)
 * headers only. Why never decode: plugin videos come from strangers, so a file whose headers
 * break the rules is refused before any decoder runs.
 */

export type PluginVideoContainer = 'mp4' | 'webm'
export type PluginVideoCodec = 'h264' | 'hevc' | 'vp8' | 'vp9' | 'av1'

export const PLUGIN_VIDEO_MIME: Record<PluginVideoContainer, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm'
}

export type PluginVideoInfo = {
  container: PluginVideoContainer
  codec: PluginVideoCodec
  width: number
  height: number
  durationMs: number
}

/** `tracks` counts every track; only a lone video track is accepted. `malformed` marks a box or
 *  element that overruns its parent or is too short for the fields read from it. */
type Draft = Partial<PluginVideoInfo> & {
  container: PluginVideoContainer
  tracks: number
  videoTracks: number
  malformed?: boolean
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function uint(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0
  for (let index = 0; index < length; index++) {
    value = value * 256 + (bytes[offset + index] ?? 0)
  }
  return value
}

const MP4_CODECS: Record<string, PluginVideoCodec> = {
  avc1: 'h264',
  avc3: 'h264',
  hvc1: 'hevc',
  hev1: 'hevc',
  vp09: 'vp9',
  av01: 'av1'
}
const MP4_CONTAINERS = new Set(['moov', 'mdia', 'minf', 'stbl'])
/** Real files nest these headers at most 5 deep; a hostile file must not recurse further. */
const MAX_DEPTH = 8

/** Walks MP4 boxes inside [start, end), descending only into the boxes that lead to a track's
 *  handler, sample description and the movie header. */
function walkMp4(
  bytes: Uint8Array,
  start: number,
  end: number,
  draft: Draft,
  track: Track,
  depth = 0,
  parent = ''
): void {
  if (depth > MAX_DEPTH) {
    return
  }
  for (let offset = start; offset + 8 <= end;) {
    let size = uint(bytes, offset, 4)
    const type = ascii(bytes, offset + 4, 4)
    let header = 8
    if (size === 1) {
      size = uint(bytes, offset + 8, 8)
      header = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < header || offset + size > end) {
      draft.malformed = true
      return
    }
    const body = offset + header
    const boxEnd = offset + size
    // Whether this box holds `length` bytes of fields from its body onward.
    const fits = (length: number): boolean => body + length <= boxEnd
    if (type === 'trak') {
      const inner: Track = {}
      walkMp4(bytes, body, boxEnd, draft, inner, depth + 1, type)
      draft.tracks++
      if (inner.handler === 'vide') {
        draft.videoTracks++
        draft.codec ??= inner.codec
        draft.width ??= inner.width
        draft.height ??= inner.height
      }
    } else if (MP4_CONTAINERS.has(type)) {
      walkMp4(bytes, body, boxEnd, draft, track, depth + 1, type)
    } else if (type === 'mvhd') {
      const wide = bytes[body] === 1
      if (!fits(wide ? 32 : 20)) {
        draft.malformed = true
        return
      }
      const timescale = uint(bytes, body + (wide ? 20 : 12), 4)
      const duration = uint(bytes, body + (wide ? 24 : 16), wide ? 8 : 4)
      draft.durationMs = timescale > 0 ? (duration * 1000) / timescale : undefined
    } else if (type === 'hdlr' && parent === 'mdia') {
      if (!fits(12)) {
        draft.malformed = true
        return
      }
      // Why only under mdia: QuickTime files add a data handler under minf.
      track.handler ??= ascii(bytes, body + 8, 4)
    } else if (type === 'stsd') {
      // One sample entry after version, flags and entry count; a visual entry stores its size
      // 24 bytes into its body. Why exactly one: a track may switch descriptions, and only the
      // one checked here may play.
      const entry = body + 8
      const entrySize = uint(bytes, entry, 4)
      if (
        !fits(8 + 36) ||
        uint(bytes, body + 4, 4) !== 1 ||
        entrySize < 36 ||
        entry + entrySize > boxEnd
      ) {
        draft.malformed = true
        return
      }
      track.codec = MP4_CODECS[ascii(bytes, entry + 4, 4)]
      track.width = uint(bytes, entry + 32, 2)
      track.height = uint(bytes, entry + 34, 2)
    }
    offset += size
  }
}

type Track = { handler?: string; codec?: PluginVideoCodec; width?: number; height?: number }

/** An EBML variable-length integer: its leading zero bits give its length. Element IDs keep the
 *  marker bit; sizes drop it, and an all-ones size means "unknown" (to the end of the parent). */
function readVint(
  bytes: Uint8Array,
  offset: number,
  keepMarker: boolean
): { value: number; length: number } | null {
  const first = bytes[offset] ?? 0
  const length = first === 0 ? 9 : Math.clz32(first) - 23
  if (length > 8 || offset + length > bytes.length) {
    return null
  }
  const mask = keepMarker ? 0xff : 0xff >> length
  let value = first & mask
  let allOnes = value === mask
  for (let index = 1; index < length; index++) {
    const byte = bytes[offset + index] ?? 0
    allOnes &&= byte === 0xff
    value = value * 256 + byte
  }
  return { value: !keepMarker && allOnes ? Infinity : value, length }
}

const EBML_HEADER = 0x1a45dfa3
const EBML_DOC_TYPE = 0x4282
const SEGMENT = 0x18538067
const INFO = 0x1549a966
const TIMECODE_SCALE = 0x2ad7b1
const DURATION = 0x4489
const TRACKS = 0x1654ae6b
const TRACK_ENTRY = 0xae
const TRACK_TYPE = 0x83
const CODEC_ID = 0x86
const VIDEO = 0xe0
const PIXEL_WIDTH = 0xb0
const PIXEL_HEIGHT = 0xba
const CLUSTER = 0x1f43b675
const WEBM_CONTAINERS = new Set([EBML_HEADER, SEGMENT, INFO, TRACKS, TRACK_ENTRY, VIDEO])
const WEBM_CODECS: Record<string, PluginVideoCodec> = {
  V_VP8: 'vp8',
  V_VP9: 'vp9',
  V_AV1: 'av1'
}

type WebmState = { docType?: string; timecodeScale: number; duration?: number }

/** Walks WebM elements inside [start, end), stopping at the first cluster: everything this
 *  reader needs comes before the media data. */
function walkWebm(
  bytes: Uint8Array,
  start: number,
  end: number,
  draft: Draft,
  state: WebmState,
  track: Track & { type?: number },
  depth = 0
): boolean {
  if (depth > MAX_DEPTH) {
    return false
  }
  for (let offset = start; offset < end;) {
    const id = readVint(bytes, offset, true)
    const size = id && readVint(bytes, offset + id.length, false)
    if (!id || !size || id.value === CLUSTER) {
      return false
    }
    const body = offset + id.length + size.length
    if (Number.isFinite(size.value) && body + size.value > end) {
      draft.malformed = true
      return false
    }
    const elementEnd = Math.min(body + size.value, end)
    // Why cap scalar reads: the fields read here are short, and a hostile size must not make a
    // giant string or a read past the buffer.
    const length = Math.min(elementEnd - body, 64)
    if (length < 0) {
      return false
    }
    if (id.value === TRACK_ENTRY) {
      const inner: Track & { type?: number } = {}
      walkWebm(bytes, body, elementEnd, draft, state, inner, depth + 1)
      draft.tracks++
      if (inner.type === 1) {
        draft.videoTracks++
        draft.codec ??= inner.codec
        draft.width ??= inner.width
        draft.height ??= inner.height
      }
    } else if (WEBM_CONTAINERS.has(id.value)) {
      if (!walkWebm(bytes, body, elementEnd, draft, state, track, depth + 1)) {
        return false
      }
    } else if (id.value === EBML_DOC_TYPE) {
      state.docType = ascii(bytes, body, length)
    } else if (id.value === TIMECODE_SCALE && length <= 8) {
      state.timecodeScale = uint(bytes, body, length)
    } else if (id.value === DURATION) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + body, length)
      state.duration =
        length === 8 ? view.getFloat64(0) : length === 4 ? view.getFloat32(0) : undefined
    } else if (id.value === TRACK_TYPE && length <= 8) {
      track.type = uint(bytes, body, length)
    } else if (id.value === CODEC_ID) {
      track.codec = WEBM_CODECS[ascii(bytes, body, length)]
    } else if (id.value === PIXEL_WIDTH && length <= 8) {
      track.width = uint(bytes, body, length)
    } else if (id.value === PIXEL_HEIGHT && length <= 8) {
      track.height = uint(bytes, body, length)
    }
    if (!Number.isFinite(size.value)) {
      return true
    }
    offset = body + size.value
  }
  return true
}

/** Container, codec, size and length of an MP4 or WebM whose only track is video; an error
 *  message for anything else. Why no audio: playback is always muted, so it would only cost
 *  bytes and demuxing. The headers are the file's claims; the renderer re-checks what decodes. */
export function readPluginVideoHeader(bytes: Uint8Array): PluginVideoInfo | string {
  let draft: Draft
  if (ascii(bytes, 4, 4) === 'ftyp') {
    draft = { container: 'mp4', tracks: 0, videoTracks: 0 }
    walkMp4(bytes, 0, bytes.length, draft, {})
  } else if (uint(bytes, 0, 4) === EBML_HEADER) {
    draft = { container: 'webm', tracks: 0, videoTracks: 0 }
    const state: WebmState = { timecodeScale: 1_000_000 }
    walkWebm(bytes, 0, bytes.length, draft, state, {})
    if (state.docType !== 'webm') {
      return 'must be an MP4 or WebM video'
    }
    if (state.duration !== undefined) {
      draft.durationMs = (state.duration * state.timecodeScale) / 1_000_000
    }
  } else {
    return 'must be an MP4 or WebM video'
  }
  const { container, codec, width, height, durationMs, tracks, videoTracks } = draft
  if (draft.malformed) {
    return 'video headers are malformed'
  }
  if (tracks !== 1 || videoTracks !== 1) {
    return 'video must have exactly one track, a video track with no audio'
  }
  if (!codec) {
    return 'video codec must be H.264, HEVC, VP8, VP9 or AV1'
  }
  if (!width || !height) {
    return 'video has no size'
  }
  if (!(durationMs !== undefined && durationMs > 0 && Number.isFinite(durationMs))) {
    return 'video has no duration'
  }
  return { container, codec, width, height, durationMs }
}
