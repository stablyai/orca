import type { TerminalOrphanRecoveryCall } from './web-session-terminal-orphan-recovery-adoption'
import type { TerminalOrphanRecoveryState } from './web-session-terminal-orphan-recovery-surface'

export type TerminalOrphanRecoveryOptions = {
  expectedEnvironmentPairingRevision?: number
  expectedRuntimeId?: string
  call?: TerminalOrphanRecoveryCall
  /** Reads live renderer topology so an RPC cannot apply a stale local claim. */
  getCurrentState?: () => TerminalOrphanRecoveryState
}
