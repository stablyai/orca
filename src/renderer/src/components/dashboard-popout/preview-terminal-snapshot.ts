import type { PreviewSession } from './preview-terminal-input-source'
import type { RemoteRuntimeMultiplexedTerminalCallbacks } from '@/runtime/remote-runtime-terminal-multiplexer-types'
import type {
  TerminalPreviewConnectResult,
  TerminalPreviewReplayChunk
} from '../../../../shared/terminal-preview'
type SnapshotMeta = Parameters<RemoteRuntimeMultiplexedTerminalCallbacks['onSnapshot']>[1]
type OutputMeta = Parameters<RemoteRuntimeMultiplexedTerminalCallbacks['onData']>[1]
const FALLBACK_COLS = 80
const FALLBACK_ROWS = 24

export function snapshotResult(
  session: PreviewSession,
  data: string,
  meta: SnapshotMeta,
  replay: TerminalPreviewReplayChunk[]
): TerminalPreviewConnectResult {
  session.grid =
    typeof meta?.cols === 'number' && typeof meta.rows === 'number'
      ? { cols: meta.cols, rows: meta.rows }
      : null
  return {
    snapshot: {
      data,
      // Why: hosts that omit dims serialized at the PTY grid; the box fit and claim correct it.
      cols: meta?.cols ?? FALLBACK_COLS,
      rows: meta?.rows ?? FALLBACK_ROWS,
      seq: meta?.seq,
      pendingEscapeTailAnsi: meta?.pendingEscapeTailAnsi,
      kittyKeyboardFlags: meta?.kittyKeyboardFlags
    },
    replay
  }
}

/** The part of a chunk the snapshot at `snapshotSeq` does not already contain. */
export function outputAfterSnapshot(
  data: string,
  meta: OutputMeta,
  snapshotSeq: number | undefined
): string | null {
  const seq = meta?.seq
  const rawLength = meta?.rawLength ?? (meta?.transformed ? undefined : data.length)
  if (snapshotSeq === undefined || seq === undefined || rawLength === undefined) {
    return data
  }
  if (seq <= snapshotSeq) {
    return null
  }
  const start = seq - rawLength
  if (start >= snapshotSeq) {
    return data
  }
  // A transformed span cannot be split by offset; the host drops it on the same boundary.
  return meta?.transformed ? null : data.slice(snapshotSeq - start)
}

// Why: chunks flushed before a requested snapshot carry no proof of order without a seq.
export function releaseGate(session: PreviewSession, snapshotSeq: number | undefined) {
  const held = session.gate ?? []
  session.gate = null
  session.snapshotSeq = snapshotSeq
  const replay: TerminalPreviewReplayChunk[] = []
  let failure: unknown
  for (const chunk of held) {
    const data =
      chunk.meta?.seq === undefined
        ? null
        : outputAfterSnapshot(chunk.data, chunk.meta, snapshotSeq)
    if (data) {
      replay.push({ data, mode: 'live' })
    }
    try {
      chunk.release()
    } catch (error) {
      failure ??= error
    }
  }
  if (failure !== undefined) {
    throw failure
  }
  return replay
}
