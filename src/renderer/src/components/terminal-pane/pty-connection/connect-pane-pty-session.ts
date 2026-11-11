import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from './pty-connection-deps'
import type { PtyTransport } from '../pty-transport/pty-transport-types'
import type { TerminalIdleCursorReset } from '../emulation/terminal-idle-cursor-reset'
import type { TerminalStreamPosition } from '../pty-transport/delivery/terminal-stream-position'
import type { PtyDataMeta } from '../pty-transport/delivery/pty-dispatcher'
import type {
  RetainedTerminalHistory,
  TerminalHistoryReadOwner
} from './reattach/retained-terminal-history'

// Extracted installers share the closure’s mutable bindings through this bag without changing call order.
export type ConnectPanePtySession = {
  pane: ManagedPane
  manager: PaneManager
  deps: PtyConnectionDeps
  // Why typed: every PTY write must name its input kind, and the bag's `any` would hide a missing one.
  transport: PtyTransport
  retainedTerminalHistory?: RetainedTerminalHistory
  terminalHistoryReadOwner?: TerminalHistoryReadOwner
  writeReplayData: (data: string) => void
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
