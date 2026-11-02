import type { OrcaSessionId } from './orca-session-address'

/** PTY parties use terminal handle/pane, structured parties use Orca session identity (orca_session_id:<id>).
 * Structured workers also have handles/panes; ordinary chats do not. Build identity at lookup boundaries and pass it whole. */
export type OrchestrationPartyIdentity = Readonly<{
  /** Mailbox address the party sends from and reads: its terminal handle, else its session address. */
  address: string
  terminalHandle: string | null
  paneKey: string | null
  /** The bare Orca session id the party is addressed by; mail spells it `orca_session_id:<id>`. */
  orcaSessionId: OrcaSessionId | null
}>
