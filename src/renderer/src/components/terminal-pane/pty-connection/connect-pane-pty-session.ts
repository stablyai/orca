import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from '../pty-connection-types'
import type { PtyTransport } from '../pty-transport-types'
import type { TerminalIdleCursorReset } from '../terminal-idle-cursor-reset'
import type { TerminalStreamPosition } from '../terminal-stream-position'
import type { PtyDataMeta } from '../pty-dispatcher'

// Extracted installers share the closure’s mutable bindings through this bag without changing call order.
export type ConnectPanePtySession = {
  pane: ManagedPane
  manager: PaneManager
  deps: PtyConnectionDeps
  // Why typed: every PTY write must name its input kind, and the bag's `any` would hide a missing one.
  transport: PtyTransport
  hiddenOutputRestoreUnhideSeq: number | null
  idleCursorReset: TerminalIdleCursorReset
  streamPosition: TerminalStreamPosition
  /** A partial query split across consecutive skipped deliveries, and the seq it continues at. */
  skippedQueryCarry: { ptyId: string; endSeq: number | undefined; pending: string } | null
  /** Admit app bytes (a delivered chunk or a suffix of it) at xterm's stream position; null skips them. */
  admitStreamBytes: (
    data: string,
    delivered: Pick<PtyDataMeta, 'seq' | 'rawLength' | 'midEscape'> & {
      data: string
    },
    /** The caller (a restore drain) repairs or has already disclosed what it skips. */
    options?: { repairsOwnSkips?: boolean }
  ) => string | null
  admitRecoveryBytes: (data: string) => string
  // oxlint-disable-next-line typescript/no-explicit-any -- session bag for mechanical extract
  [key: string]: any
}
