import type { OrcaSessionId } from './orca-session-address'

/**
 * Who an orchestration party is, as Run binding and mail routing match it.
 *
 * A PTY agent is its terminal: a handle and a pane key, no Orca session id. An agent that is a
 * structured session is its Orca session id, addressed as `orca_session_id:<id>`; a structured worker also
 * has the handle and pane key it was minted, and an ordinary chat has neither. Methods pass this
 * through whole and never branch on which fields are set; the lookups that build it own that.
 */
export type OrchestrationPartyIdentity = Readonly<{
  /** Mailbox address the party sends from and reads: its terminal handle, else its session address. */
  address: string
  terminalHandle: string | null
  paneKey: string | null
  /** The bare Orca session id the party is addressed by; mail spells it `orca_session_id:<id>`. */
  orcaSessionId: OrcaSessionId | null
}>
