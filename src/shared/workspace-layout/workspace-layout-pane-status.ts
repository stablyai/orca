// A pane's status, derived at publish from facts the runtime already holds; it is never stored, so
// it cannot drift from them (design §1.1). `unverifiable` follows the SSH execution boundary: loss
// of contact is never evidence that a process exited.

import type { PaneOutcome } from './workspace-layout-pane-outcomes'

export type PaneStatus =
  | 'starting'
  | 'waiting_for_host'
  | 'running'
  | 'exited'
  | 'sleeping'
  | 'restorable'
  | 'failed'
  | 'unverifiable'

/**
 * Whether the pane's host can be used: `awaiting` before this runtime can start terminals there
 * (a saved `ssh:` partition not yet converted, or a host not reached yet), `lost` once contact
 * with a host that runs the pane's terminal is gone.
 */
export type PaneHostReach = 'reachable' | 'awaiting' | 'lost'

/** What the PTY registry says of the pane's bound terminal; null when unbound or not registered. */
export type PaneTerminalFact = 'live' | 'exited' | 'unverifiable' | null

export type PaneStatusFacts = {
  /** A start attempt (J) is in flight for this pane. */
  starting: boolean
  /** The pane's entry in the holder's `PaneOutcomes` (kept by `applyPaneOutcomeChanges`). */
  lastOutcome: PaneOutcome | null
  /** The pane holds a sleeping agent record. */
  sleeping: boolean
  terminal: PaneTerminalFact
  host: PaneHostReach
}

/**
 * First match wins. An outcome or sleeping record outranks the host: both describe this pane's
 * last known state without asking the host. A bound pane whose terminal the registry does not
 * know is `restorable`: a view that shows it starts it.
 */
export function derivePaneStatus(facts: PaneStatusFacts): PaneStatus {
  if (facts.starting) {
    return 'starting'
  }
  if (facts.lastOutcome) {
    return facts.lastOutcome
  }
  if (facts.sleeping) {
    return 'sleeping'
  }
  if (facts.host === 'awaiting' || (facts.host === 'lost' && facts.terminal === null)) {
    return 'waiting_for_host'
  }
  // A terminal on a host out of contact may still run; only an exit proven before stays `exited`.
  if (facts.host === 'lost' && facts.terminal !== 'exited') {
    return 'unverifiable'
  }
  switch (facts.terminal) {
    case 'live':
      return 'running'
    case 'exited':
      return 'exited'
    case 'unverifiable':
      return 'unverifiable'
    case null:
      return 'restorable'
  }
}
