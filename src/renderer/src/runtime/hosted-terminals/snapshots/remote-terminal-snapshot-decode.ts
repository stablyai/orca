import { decodeTerminalStreamJson } from '../../../../../shared/terminal/stream/terminal-stream-protocol'
import { parseTerminalSnapshotUnavailableReason } from '../../../../../shared/terminal/replay/terminal-snapshot-unavailability'
import { parseTerminalKittyKeyboardFlags } from '../../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-flags'
import type { RemoteRuntimeSnapshotInfo } from './remote-terminal-snapshot-contracts'

export function concatBytes(chunks: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBufferLike> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export function decodeSnapshotInfo(
  payload: Uint8Array<ArrayBufferLike>
): RemoteRuntimeSnapshotInfo | null {
  const raw = decodeTerminalStreamJson<{
    cols?: unknown
    rows?: unknown
    seq?: unknown
    source?: unknown
    requestId?: unknown
    truncated?: unknown
    unavailable?: unknown
    pendingEscapeTailAnsi?: unknown
    kittyKeyboardFlags?: unknown
    alternateScreen?: unknown
    terminalOwner?: unknown
    lastTitle?: unknown
    scrollbackRows?: unknown
  }>(payload)
  if (!raw) {
    return null
  }
  return {
    cols: typeof raw.cols === 'number' ? raw.cols : undefined,
    rows: typeof raw.rows === 'number' ? raw.rows : undefined,
    seq: typeof raw.seq === 'number' ? raw.seq : undefined,
    source: raw.source === 'headless' || raw.source === 'renderer' ? raw.source : undefined,
    // Negative, fractional, and unsafe values are treated as absent, never clamped.
    kittyKeyboardFlags: parseTerminalKittyKeyboardFlags(raw.kittyKeyboardFlags),
    alternateScreen:
      raw.terminalOwner === 'shell' && typeof raw.alternateScreen === 'boolean'
        ? raw.alternateScreen
        : undefined,
    terminalOwner: raw.terminalOwner === 'shell' ? raw.terminalOwner : undefined,
    lastTitle: typeof raw.lastTitle === 'string' ? raw.lastTitle : undefined,
    requestId: typeof raw.requestId === 'number' ? raw.requestId : undefined,
    truncated: raw.truncated === true,
    unavailable: parseTerminalSnapshotUnavailableReason(raw.unavailable),
    scrollbackRows:
      typeof raw.scrollbackRows === 'number' &&
      Number.isSafeInteger(raw.scrollbackRows) &&
      raw.scrollbackRows >= 0
        ? raw.scrollbackRows
        : undefined,
    pendingEscapeTailAnsi:
      typeof raw.pendingEscapeTailAnsi === 'string' ? raw.pendingEscapeTailAnsi : undefined
  }
}
