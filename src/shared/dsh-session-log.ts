import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { resolveAbsoluteDirOverride } from './absolute-dir-override'

/**
 * DSH keeps one concatenated-Zstandard JSONL log per session under
 * `$DSH_HOME/sessions/<cwd slug>/<session id>/session.v<version>.jsonl.zstd`.
 * Node's one-shot zstd decoder stops at the first frame, so the container's
 * frame boundaries are walked explicitly (same layout dsh-session-persistence-jsonl writes).
 */
const ZSTD_MAGIC = 0xfd2fb528

type ZstdFrameRange = { start: number; end: number }

type ZstdFrameScan = { frames: ZstdFrameRange[]; tornStart: number | null }

export function resolveDshSessionsDir(override?: string): string {
  if (override?.trim()) {
    return override.trim()
  }
  const dshHome = resolveAbsoluteDirOverride(process.env.DSH_HOME, join(homedir(), '.dsh'))
  return join(dshHome, 'sessions')
}

export function dshSessionIdFromFilePath(filePath: string): string {
  // The session id is the directory name; the log file name is versioned by format.
  return basename(dirname(filePath))
}

function isZstdFrame(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC
}

/** Complete frames only; a torn final frame (crash mid-append) is reported instead of decoded. */
function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) {
      return { frames, tornStart: start }
    }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) {
      return { frames, tornStart: start }
    }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(
        `corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`
      )
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) {
      return { frames, tornStart: start }
    }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) {
        return { frames, tornStart: start }
      }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) {
        return { frames, tornStart: start }
      }
      offset += payloadBytes
      if (lastBlock) {
        break
      }
    }
    if (checksum) {
      if (buffer.length - offset < 4) {
        return { frames, tornStart: start }
      }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) {
      return { frames, tornStart: null }
    }
  }
  return { frames, tornStart: null }
}

/**
 * Lines of a session log, decoded one frame at a time so a 60 MB transcript never
 * lands on the heap whole. A plain JSONL file (compression: none) passes through.
 */
export function* dshSessionLines(buffer: Buffer): Generator<string> {
  if (!isZstdFrame(buffer)) {
    yield* buffer.toString('utf8').split('\n')
    return
  }
  const { frames } = scanZstdFrames(buffer)
  let carry = ''
  for (const frame of frames) {
    const decoded =
      carry + zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    const parts = decoded.split('\n')
    carry = parts.pop() ?? ''
    yield* parts
  }
  // The final line has no trailing newline in a live write; keep it rather than dropping the tail.
  if (carry) {
    yield carry
  }
}
