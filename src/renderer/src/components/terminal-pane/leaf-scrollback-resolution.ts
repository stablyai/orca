import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

export type LeafScrollbackHomes = {
  /** `TerminalLayoutSnapshot.buffersByLeafId` — shared with peers through the remote projection. */
  shared: Pick<TerminalLayoutSnapshot, 'buffersByLeafId'> | undefined
  /** `localOnlyScrollbackByTabId[tabId]` — never leaves this client. */
  localOnly: Record<string, string> | undefined
}

/** The one read of a leaf's scrollback across its two homes; no consumer touches either directly.
 *  Why local-only wins a conflict: it is written by the ordinary park, and every shared capture
 *  clears it, so whenever both hold a leaf the local copy is the later one. */
export function resolveLeafScrollbackBuffers({
  shared,
  localOnly
}: LeafScrollbackHomes): Record<string, string> | undefined {
  const sharedBuffers = shared?.buffersByLeafId
  if (!localOnly || Object.keys(localOnly).length === 0) {
    return sharedBuffers
  }
  return sharedBuffers ? { ...sharedBuffers, ...localOnly } : localOnly
}
