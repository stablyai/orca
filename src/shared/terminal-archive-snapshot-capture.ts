import { getUtf8ByteLength } from './utf8-byte-limits'
import type {
  TerminalArchivePaneSnapshotCapture,
  TerminalArchivePaneSnapshotInput
} from './workspace-session-terminal-archive'

/** Applies the archive contract that a budget-truncated empty tail is not proof of emptiness. */
export function captureTerminalArchiveBuffer(args: {
  buffer: string
  source: TerminalArchivePaneSnapshotInput['source']
  truncated?: boolean
}): TerminalArchivePaneSnapshotCapture {
  const truncated = args.truncated ?? false
  if (args.buffer.length === 0) {
    return truncated ? { kind: 'unavailable' } : { kind: 'captured-empty' }
  }
  return {
    kind: 'captured-bytes',
    buffer: args.buffer,
    source: args.source,
    truncated,
    byteLength: getUtf8ByteLength(args.buffer)
  }
}
