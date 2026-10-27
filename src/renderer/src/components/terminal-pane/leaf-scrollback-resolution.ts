import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { TERMINAL_SCROLLBACK_SESSION_HOMES } from '../../../../shared/workspace-session-terminal-buffers'

/** Track every persisted scrollback home; adding one must also extend this resolver. */
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

/** Read both homes; local-only wins because ordinary park writes it and shared capture clears it, making any surviving local copy newer. */
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
