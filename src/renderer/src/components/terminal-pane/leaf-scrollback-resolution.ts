import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { TERMINAL_SCROLLBACK_SESSION_HOMES } from '../../../../shared/workspace-session-terminal-buffers'

/** The session fields a tab's scrollback can live in — typed off the same constant the cap
 *  enumerates, so a third home is a compile error here until this resolver reads it. */
export type TerminalScrollbackSessionHomes = Pick<
  WorkspaceSessionState,
  (typeof TERMINAL_SCROLLBACK_SESSION_HOMES)[number]
>

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

/** Same read, addressed by tab over a session-shaped record (the store or a parsed session file). */
export function resolveTabScrollbackBuffers(
  session: Partial<TerminalScrollbackSessionHomes>,
  tabId: string
): Record<string, string> | undefined {
  return resolveLeafScrollbackBuffers({
    shared: session.terminalLayoutsByTabId?.[tabId],
    localOnly: session.localOnlyScrollbackByTabId?.[tabId]
  })
}
