/**
 * Sizes of the serialized terminal scrollback the store holds, in characters.
 *
 * Why this is separate from the store profile: summarizeStateCollectionSizes counts
 * own keys and does not recurse, so terminalLayoutsByTabId reports how many tabs
 * exist while each one hides N leaf buffers of up to
 * TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT (512KB). A count of 170 is
 * consistent with anywhere from kilobytes to ~1GB, which is the exact ambiguity
 * an OOM highwater breadcrumb needs resolved.
 *
 * Read coldRestores/coldRestoreChars as a tripwire, not evidence: nothing currently
 * writes a key into pendingColdRestoreByPtyId (the live cold-restore payload goes
 * straight to xterm via writeReplayData), so today they are 0 by construction. They
 * stay so a future writer is measured on arrival rather than silently unmeasured.
 */
import type { TerminalLayoutSnapshot } from '../../../shared/types'

/** `chars`/`coldRestoreChars` are UTF-16 code units, not bytes — CJK and emoji
 *  under-report up to 3x. */
export type TerminalScrollbackCensus = {
  layouts: number
  buffers: number
  chars: number
  coldRestores: number
  coldRestoreChars: number
}

type TerminalScrollbackCensusState = {
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  pendingColdRestoreByPtyId: Record<string, { scrollback: string; cwd: string }>
}

function sumRecordStringLengths(record: Record<string, string> | undefined): {
  entries: number
  chars: number
} {
  let entries = 0
  let chars = 0
  if (!record) {
    return { entries, chars }
  }
  for (const key in record) {
    if (!Object.hasOwn(record, key)) {
      continue
    }
    entries += 1
    // .length is O(1) even on a rope; it does not flatten the string.
    chars += record[key]?.length ?? 0
  }
  return { entries, chars }
}

export function measureTerminalScrollbackBuffers(
  state: TerminalScrollbackCensusState
): TerminalScrollbackCensus {
  let layouts = 0
  let buffers = 0
  let chars = 0
  const layoutsByTabId = state.terminalLayoutsByTabId
  for (const tabId in layoutsByTabId) {
    if (!Object.hasOwn(layoutsByTabId, tabId)) {
      continue
    }
    layouts += 1
    const leaf = sumRecordStringLengths(layoutsByTabId[tabId]?.buffersByLeafId)
    buffers += leaf.entries
    chars += leaf.chars
  }
  let coldRestores = 0
  let coldRestoreChars = 0
  const pending = state.pendingColdRestoreByPtyId
  for (const ptyId in pending) {
    if (!Object.hasOwn(pending, ptyId)) {
      continue
    }
    coldRestores += 1
    coldRestoreChars += pending[ptyId]?.scrollback?.length ?? 0
  }
  return { layouts, buffers, chars, coldRestores, coldRestoreChars }
}
